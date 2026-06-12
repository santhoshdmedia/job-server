const CounterSchema = require("../modals/Counter.model");

const AREA_UNITS = new Set(["sqft", "sqm"]);
const isAreaUnit = (unit) => AREA_UNITS.has(unit);

// ─── Stopwords ignored when deriving initials from the product name ──────────
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "in", "on",
]);

/**
 * Extract a short alphabetic prefix from the product name.
 *
 *   "Normal Flex 10 X 10" -> "NF"
 *   "Vinyl 3mm"           -> "V"     (single significant word -> first letters)
 *   "PVC Foam Board"      -> "PFB"
 *
 * Numbers / size tokens inside the name itself are ignored here — the
 * width/height (when present) are appended separately by buildProductCode.
 */
const deriveNameInitials = (name = "") => {
  const words = String(name)
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z]/g, "")) // strip digits/symbols
    .filter((w) => w.length > 0 && !STOPWORDS.has(w.toLowerCase()));

  if (words.length === 0) return "X";

  if (words.length === 1) {
    // Single word: use first letter, plus second letter if the word is long
    // e.g. "Vinyl" -> "V"   (kept short on purpose; "VI" also acceptable)
    const w = words[0];
    return w.length >= 4 ? w[0].toUpperCase() : w.slice(0, 1).toUpperCase();
  }

  // Multi-word: take first letter of each significant word (max 3 letters)
  return words
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join("");
};

/**
 * Extract a numeric "size token" to append to the prefix.
 *
 * Priority:
 *   1. If the product name itself contains digits (e.g. "Vinyl 3mm" -> "3",
 *      "Normal Flex 10 X 10" -> "10X10"), use those.
 *   2. Else, if a size object with width/height was supplied, use those
 *      (rounded to drop trailing ".0").
 *   3. Else, empty string (no size token — e.g. plain "pcs" products like "Pen").
 *
 * Examples:
 *   name="Normal Flex 10 X 10", size={width:10,height:10} -> "10X10"
 *   name="Vinyl 3mm",            size=null                -> "3"
 *   name="Pen",                  size=null                -> ""
 */
const deriveSizeToken = (name = "", size = null) => {
  // 1. Numbers embedded in the name (e.g. "10 X 10", "3mm")
  const nameDigits = String(name).match(/\d+(\.\d+)?/g);
  if (nameDigits && nameDigits.length > 0) {
    const cleaned = nameDigits.map((d) => d.replace(/\.0+$/, ""));
    if (cleaned.length >= 2) return `${cleaned[0]}X${cleaned[1]}`;
    return cleaned[0];
  }

  // 2. Fallback to explicit size object (width x height)
  if (size && (size.width != null || size.height != null)) {
    const fmt = (n) => {
      if (n == null) return "";
      const num = Number(n);
      return Number.isInteger(num) ? `${num}` : `${num}`.replace(/\.0+$/, "");
    };
    const w = fmt(size.width);
    const h = fmt(size.height);
    if (w && h) return `${w}X${h}`;
    return w || h || "";
  }

  // 3. Nothing usable
  return "";
};

/**
 * Atomically increment and return the next N values of the global sequence.
 * Returns an array of integers, e.g. requesting 3 starting from current=5
 * returns [6, 7, 8] and leaves the counter at 8.
 */
const reserveSequenceRange = async (count = 1) => {
  const n = Math.max(1, Number(count) || 1);
  const updated = await CounterSchema.findOneAndUpdate(
    { key: "product_code" },
    { $inc: { value: n } },
    { new: true, upsert: true }
  );
  const last = updated.value;        // e.g. 8
  const first = last - n + 1;        // e.g. 6
  const seq = [];
  for (let i = first; i <= last; i++) seq.push(i);
  return seq; // [6,7,8]
};

/**
 * Peek at the next N sequence numbers WITHOUT incrementing the counter.
 * Used for the live preview endpoint.
 */
const peekSequenceRange = async (count = 1) => {
  const n = Math.max(1, Number(count) || 1);
  const doc = await CounterSchema.findOne({ key: "product_code" }).lean();
  const current = doc ? doc.value : 0;
  const seq = [];
  for (let i = 1; i <= n; i++) seq.push(current + i);
  return seq;
};

/**
 * Format a sequence number as a zero-padded 3-digit string.
 * Falls back to plain digits if the sequence exceeds 999.
 */
const formatSeq = (n) => String(n).padStart(3, "0");

/**
 * Build a single product code string.
 *
 *   DM + <name initials> + <size token (optional)> - <seq>
 *
 * Examples:
 *   buildProductCode({ name: "Normal Flex 10 X 10", primaryUnit: "sqft", size: {width:10,height:10} }, 1)
 *     -> "DMNF10X10-001"
 *   buildProductCode({ name: "Vinyl 3mm", primaryUnit: "sqft" }, 2)
 *     -> "DMV3-002"
 *   buildProductCode({ name: "Pen", primaryUnit: "pcs" }, 3)
 *     -> "DMP-003"
 */
const buildProductCode = ({ name, primaryUnit, size }, seqNumber) => {
  const initials  = deriveNameInitials(name);
  const sizeToken = deriveSizeToken(name, size);
  const prefix    = `DM${initials}${sizeToken}`;
  return `${prefix}-${formatSeq(seqNumber)}`;
};

/**
 * Generate `quantity` sequential codes for a NEW product creation
 * (this RESERVES / consumes sequence numbers — call only at creation time).
 *
 * Returns: { codes: string[], firstSeq: number, lastSeq: number }
 */
const generateProductCodes = async ({ name, primaryUnit, size, quantity = 1 }) => {
  const qty = Math.max(1, Number(quantity) || 1);
  const seqRange = await reserveSequenceRange(qty);
  const codes = seqRange.map((seq) => buildProductCode({ name, primaryUnit, size }, seq));
  return { codes, firstSeq: seqRange[0], lastSeq: seqRange[seqRange.length - 1] };
};

/**
 * Generate a PREVIEW of `quantity` codes WITHOUT consuming sequence numbers.
 * Used by the frontend's live "Auto Codes" preview while the user is
 * still filling out the form.
 *
 * Returns: { codes: string[] }
 */
const previewProductCodes = async ({ name, primaryUnit, size, quantity = 1 }) => {
  const qty = Math.max(1, Number(quantity) || 1);
  const seqRange = await peekSequenceRange(qty);
  const codes = seqRange.map((seq) => buildProductCode({ name, primaryUnit, size }, seq));
  return { codes };
};

module.exports = {
  isAreaUnit,
  deriveNameInitials,
  deriveSizeToken,
  buildProductCode,
  reserveSequenceRange,
  peekSequenceRange,
  generateProductCodes,
  previewProductCodes,
};