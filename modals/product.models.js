// ==================== PRODUCT MODEL ====================
// Fields added / updated:
//   • material_brand  {String}  — Brand / manufacturer name (e.g. "3M", "LG Hausys")
//   • size            {Object}  — Physical dimensions: { width, height, unit }
// All other fields are preserved unchanged.

const { default: mongoose } = require("mongoose");

// ─── Supported stock-tracking units ──────────────────────────────────────────
const UNIT_ENUM = ["sqft", "sqm", "feet", "meters", "pcs", "kg", "rolls"];

// ─── Supported size-dimension units ──────────────────────────────────────────
// Kept separate from UNIT_ENUM so physical dimensions are never confused
// with stock-tracking units.
const SIZE_UNIT_ENUM = ["inches", "feet", "cm", "meters", "mm"];

// ─── Sub-schema: unit-quantity pair (stock tracking) ─────────────────────────
const unitQtySchema = new mongoose.Schema(
  {
    qty:  { type: Number, default: 0 },
    unit: { type: String, enum: UNIT_ENUM, default: "pcs" },
  },
  { _id: false }
);

// ─── Sub-schema: physical size of the product ────────────────────────────────
// Stores Width × Height with a shared measurement unit.
// Both width and height are nullable so partial sizes are supported
// (e.g. width-only roll of vinyl).
const sizeSchema = new mongoose.Schema(
  {
    width:  { type: Number, default: null },  // e.g. 4.0  (feet)
    height: { type: Number, default: null },  // e.g. 8.0  (feet)
    unit:   { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
  },
  { _id: false }
);

// ─── Sub-schema: stock IN entry ───────────────────────────────────────────────
const stockInfoSchema = new mongoose.Schema(
  {
    date:         { type: Date,   default: Date.now },
    add_stock:    { type: Number },
    unit_qty:     { type: unitQtySchema, default: () => ({ qty: 0, unit: "pcs" }) },
    buy_price:    { type: String },
    invoice:      { type: String },
    handler_name: { type: String },
    location:     { type: String },
    stock_images: { type: Array },
    notes:        { type: String },
  },
  { _id: false }
);

// ─── Sub-schema: stock OUT entry ──────────────────────────────────────────────
const stockOfflineSchema = new mongoose.Schema(
  {
    date:             { type: Date,   default: Date.now },
    stock:            { type: Number },
    unit_qty:         { type: unitQtySchema, default: () => ({ qty: 0, unit: "pcs" }) },
    customer_details: { type: String },
    handler_name:     { type: String },
    location:         { type: String },
    notes:            { type: String },
  },
  { _id: false }
);

// ─── Sub-schema: material issuance log entry ──────────────────────────────────
const materialIssueLogSchema = new mongoose.Schema(
  {
    issue_id:        { type: mongoose.Schema.Types.ObjectId, ref: "material_issue" },
    issue_no:        { type: String },
    job_no:          { type: String },
    issued_qty:      { type: Number },
    unit_qty:        { type: unitQtySchema, default: () => ({ qty: 0, unit: "sqft" }) },
    issued_to:       { type: String },
    issued_by:       { type: String },
    issued_at:       { type: Date, default: Date.now },
    returned_qty:    { type: Number, default: null },
    return_unit_qty: { type: unitQtySchema, default: null },
    unit:            { type: String, enum: UNIT_ENUM, default: "sqft" },
    notes:           { type: String, default: "" },
  },
  { _id: false }
);

// ─── Sub-schema: per-unit stock summary ───────────────────────────────────────
const unitStockSummarySchema = new mongoose.Schema(
  {
    unit:      { type: String, enum: UNIT_ENUM },
    total_in:  { type: Number, default: 0 },
    total_out: { type: Number, default: 0 },
    net_stock: { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── Main Product Schema ──────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    name:             { type: String, required: true },
    type:             {
      type: String,
      enum: ["Stand Alone Product", "Variable Product", "Variant Product"],
    },
    HSNcode_time:     { type: String },
    product_code:     { type: String },
    product_codeS_NO: { type: String },
    Vendor_Code:      { type: String },
    seo_url:          { type: String },

    // ── NEW: Material Brand ───────────────────────────────────────────────────
    // Free-text brand / manufacturer name of the raw material.
    // Stored at the product level — not per-variant.
    // Optional; defaults to "" so existing documents are unaffected.
    material_brand: {
      type:    String,
      default: "",
      trim:    true,
    },

    // ── NEW: Physical Size ────────────────────────────────────────────────────
    // Width × Height with a shared measurement unit.
    // The sub-schema uses SIZE_UNIT_ENUM (inches / feet / cm / meters / mm)
    // which is intentionally separate from the stock-tracking UNIT_ENUM.
    // null means "no size specified" — this is the default for old documents.
    size: {
      type:    sizeSchema,
      default: null,
    },

    // ── Pricing ───────────────────────────────────────────────────────────────
    MRP_price:              { type: String },
    customer_product_price: { type: String },
    Deler_product_price:    { type: String },
    corporate_product_price:{ type: String },

    // ── Stock ─────────────────────────────────────────────────────────────────
    stock_count:   { type: Number },
    stocks_status: { type: String },
    stock_info:    [stockInfoSchema],
    stock_offline: [stockOfflineSchema],

    // ── Unit configuration ────────────────────────────────────────────────────
    primary_unit: {
      type:    String,
      enum:    UNIT_ENUM,
      default: "pcs",
    },
    supported_units: {
      type:    [{ type: String, enum: UNIT_ENUM }],
      default: ["pcs"],
    },
    unit_stock_summary: {
      type:    [unitStockSummarySchema],
      default: [],
    },

    // ── Images ────────────────────────────────────────────────────────────────
    images: { type: Array },

    // ── Visibility ────────────────────────────────────────────────────────────
    is_visible: { type: Boolean, default: false },
    is_cloned:  { type: Boolean, default: false },
    parent_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  "product",
      default: null,
    },

    // ── Category & Vendor references ──────────────────────────────────────────
    category_details:     { type: mongoose.Schema.Types.ObjectId, ref: "main_category" },
    sub_category_details: { type: mongoose.Schema.Types.ObjectId, ref: "sub_category" },
    vendor_details:       { type: mongoose.Schema.Types.ObjectId, ref: "vendor" },

    // ── Variants ──────────────────────────────────────────────────────────────
    variants:       { type: Array, default: [] },
    variants_price: { type: Array, default: [] },

    // ── Material issuance log ─────────────────────────────────────────────────
    material_issues: {
      type:    [materialIssueLogSchema],
      default: [],
    },

    // ── Derived material stats ────────────────────────────────────────────────
    material_stats: {
      total_issued_qty:   { type: Number, default: 0 },
      total_returned_qty: { type: Number, default: 0 },
      total_wastage_qty:  { type: Number, default: 0 },
      avg_wastage_pct:    { type: Number, default: 0 },
      issue_count:        { type: Number, default: 0 },
      stats_unit:         { type: String, enum: UNIT_ENUM, default: "sqft" },
      _last_updated:      { type: Date,   default: null },
    },
  },
  {
    collection: "product",
    timestamps: true,   // adds createdAt & updatedAt automatically
  }
);

// ─── Optional indexes for common queries ──────────────────────────────────────
// Uncomment whichever you use frequently.

// productSchema.index({ material_brand: 1 });          // filter by brand
// productSchema.index({ "size.unit": 1 });             // filter by size unit
// productSchema.index({ primary_unit: 1 });            // filter by unit
// productSchema.index({ name: "text" });               // full-text on name

module.exports = mongoose.model("product", productSchema);

/*
=============================================================================
NEW FIELD NOTES
=============================================================================

MATERIAL BRAND  (material_brand: String)
  ● Free-text; trim whitespace automatically.
  ● Stored at the product level, not per-variant.
  ● Examples:  "3M"  |  "LG Hausys"  |  "Avery Dennison"  |  ""
  ● Existing documents get default "" — no migration needed.

SIZE  (size: { width, height, unit })
  ● Both width and height are nullable so partial sizes work fine.
      { width: 54, height: null, unit: "inches" }  ← roll width only
      { width: 4,  height: 8,   unit: "feet"   }  ← full sheet
  ● size: null means "not specified" (default for all existing documents).
  ● SIZE_UNIT_ENUM:  "inches" | "feet" | "cm" | "meters" | "mm"
    (separate from UNIT_ENUM which is used for stock-quantity units)

MIGRATION (if you want explicit defaults in old documents)
  db.product.updateMany(
    { material_brand: { $exists: false } },
    { $set: { material_brand: "" } }
  );
  db.product.updateMany(
    { size: { $exists: false } },
    { $set: { size: null } }
  );
=============================================================================
*/