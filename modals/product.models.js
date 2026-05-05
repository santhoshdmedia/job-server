// ==================== PRODUCT MODEL (UPDATED — Unit-Aware Quantities) ====================
// Adds per-unit quantity tracking to stock entries and material issuances.
// Products can now store stock in different unit types (sqft, feet, meters, pcs, kg, rolls).
// All existing fields are preserved unchanged.

const { default: mongoose } = require("mongoose");

// ─── Supported units ─────────────────────────────────────────────────────────
// sqft  = square feet  (area material, e.g. vinyl, banner)
// sqm   = square meters (area material, metric)
// feet  = linear feet  (roll material measured by length)
// meters= linear meters
// pcs   = individual pieces / units
// kg    = weight
// rolls = full rolls of material

const UNIT_ENUM = ["sqft", "sqm", "feet", "meters", "pcs", "kg", "rolls"];

// ─── Sub-schema: unit-quantity pair ──────────────────────────────────────────
// Stored inside each stock_info entry and material_issue log so every
// transaction records BOTH the raw count AND the unit dimension.
// Example: add_stock: 3 rolls, each roll is 50 sqft → qty: 150, unit: "sqft"
const unitQtySchema = new mongoose.Schema(
  {
    qty:  { type: Number, default: 0 },      // absolute quantity in `unit`
    unit: { type: String, enum: UNIT_ENUM, default: "pcs" },
  },
  { _id: false }
);

// ─── Sub-schema: stock IN entry ───────────────────────────────────────────────
const stockInfoSchema = new mongoose.Schema(
  {
    date:         { type: Date,   default: Date.now },
    add_stock:    { type: Number },          // legacy: raw piece/roll count
    // NEW: unit-aware quantity
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
    stock:            { type: Number },      // legacy: raw count
    // NEW: unit-aware quantity
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
    issue_id:     { type: mongoose.Schema.Types.ObjectId, ref: "material_issue" },
    issue_no:     { type: String },
    job_no:       { type: String },
    issued_qty:   { type: Number },
    // NEW: unit-aware issued quantity (replaces bare `unit` string)
    unit_qty:     { type: unitQtySchema, default: () => ({ qty: 0, unit: "sqft" }) },
    issued_to:    { type: String },
    issued_by:    { type: String },
    issued_at:    { type: Date, default: Date.now },
    returned_qty: { type: Number, default: null },
    // NEW: unit-aware return quantity
    return_unit_qty: { type: unitQtySchema, default: null },
    unit:         { type: String, enum: UNIT_ENUM, default: "sqft" }, // kept for legacy reads
    notes:        { type: String, default: "" },
  },
  { _id: false }
);

// ─── Sub-schema: per-unit stock summary ───────────────────────────────────────
// Tracks the net stock broken down by each unit type independently.
// e.g. a vinyl product may simultaneously track sqft AND rolls.
const unitStockSummarySchema = new mongoose.Schema(
  {
    unit:         { type: String, enum: UNIT_ENUM },
    total_in:     { type: Number, default: 0 },
    total_out:    { type: Number, default: 0 },
    net_stock:    { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────

module.exports = mongoose.model(
  "product",
  new mongoose.Schema(
    {
      // ── Identity (unchanged) ────────────────────────────────────────────────
      name:             { type: String, required: true },
      type:             { type: String, enum: ["Stand Alone Product", "Variable Product", "Variant Product"] },
      HSNcode_time:     { type: String },
      product_code:     { type: String },
      product_codeS_NO: { type: String },

      // ── Stock (updated) ─────────────────────────────────────────────────────
      stock_count:   { type: Number },            // legacy: piece count (kept for compatibility)
      stocks_status: { type: String },
      stock_info:    [stockInfoSchema],
      stock_offline: [stockOfflineSchema],

      // ── NEW: Primary unit for this product ──────────────────────────────────
      // Determines which unit is shown by default in stock modals and the table.
      primary_unit:  { type: String, enum: UNIT_ENUM, default: "pcs" },

      // ── NEW: Additional units this product supports ───────────────────────
      // Allows a product to be tracked in multiple unit dimensions simultaneously.
      // e.g. vinyl roll = ["rolls", "sqft"]; lumber = ["feet", "pcs"]
      supported_units: {
        type: [{ type: String, enum: UNIT_ENUM }],
        default: ["pcs"],
      },

      // ── NEW: Per-unit stock summary (auto-updated on stock in/out) ──────────
      unit_stock_summary: {
        type:    [unitStockSummarySchema],
        default: [],
      },

      // ── Images (unchanged) ──────────────────────────────────────────────────
      images: { type: Array },

      // ── Material issuance log ────────────────────────────────────────────────
      material_issues: {
        type:    [materialIssueLogSchema],
        default: [],
      },

      // ── Derived material stats (updated on every issue/return) ───────────────
      material_stats: {
        total_issued_qty:   { type: Number, default: 0 },
        total_returned_qty: { type: Number, default: 0 },
        total_wastage_qty:  { type: Number, default: 0 },
        avg_wastage_pct:    { type: Number, default: 0 },
        issue_count:        { type: Number, default: 0 },
        // NEW: unit used for material_stats totals
        stats_unit:         { type: String, enum: UNIT_ENUM, default: "sqft" },
        _last_updated:      { type: Date,   default: null },
      },
    },
    {
      collection: "product",
      timestamps: true,
    }
  )
);

/*
=============================================================================
UNIT DESIGN NOTES
=============================================================================

PRIMARY UNIT
  The `primary_unit` field sets which unit is displayed by default in the UI.
  Every stock-in and stock-out entry records a `unit_qty` sub-document so
  historical entries are always interpretable regardless of future unit changes.

SUPPORTED UNITS
  A product may be received in rolls and consumed in sqft.
  Set supported_units: ["rolls", "sqft"] and record:
    - stock_info entries with unit_qty: { qty: 3, unit: "rolls" }
    - stock_offline entries with unit_qty: { qty: 150, unit: "sqft" }
  The UI will display both summaries side by side.

UNIT STOCK SUMMARY
  unit_stock_summary is a denormalised view rebuilt on every stock mutation:
  [
    { unit: "rolls", total_in: 3, total_out: 0, net_stock: 3 },
    { unit: "sqft",  total_in: 0, total_out: 150, net_stock: -150 }
  ]
  Run this aggregation to rebuild it for existing documents:

  db.material_issue.aggregate([
    { $group: {
        _id:               "$material.product_id",
        total_issued:      { $sum: "$issued_qty" },
        total_returned:    { $sum: "$return.returned_qty" },
        total_wastage:     { $sum: "$return.actual_wastage_qty" },
        avg_wastage_ratio: { $avg: "$return.wastage_ratio_pct" },
        issue_count:       { $sum: 1 },
    }},
    { $merge: { into: "product",
        on: "_id",
        whenMatched: [{ $set: {
          "material_stats.total_issued_qty":   "$$new.total_issued",
          "material_stats.total_returned_qty": "$$new.total_returned",
          "material_stats.total_wastage_qty":  "$$new.total_wastage",
          "material_stats.avg_wastage_pct":    "$$new.avg_wastage_ratio",
          "material_stats.issue_count":        "$$new.issue_count",
        }}],
    }},
  ]);

MIGRATION
  Existing documents without primary_unit / supported_units / unit_stock_summary
  will receive defaults ("pcs" / ["pcs"] / []) automatically — no migration needed.
  Existing stock_info and stock_offline entries without unit_qty will default to
  { qty: 0, unit: "pcs" }. You may want to backfill these using:

  db.product.updateMany(
    { "stock_info.unit_qty": { $exists: false } },
    { $set: { "stock_info.$[].unit_qty": { qty: 0, unit: "pcs" } } }
  );
  db.product.updateMany(
    { "stock_offline.unit_qty": { $exists: false } },
    { $set: { "stock_offline.$[].unit_qty": { qty: 0, unit: "pcs" } } }
  );

=============================================================================
*/