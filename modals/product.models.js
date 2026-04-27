// ==================== PRODUCT MODEL (UPDATED) ====================
// Adds material_issues tracking array alongside existing stock_info / stock_offline.
// All existing fields are preserved unchanged.

const { default: mongoose } = require("mongoose");

// ─── Sub-schemas (unchanged) ──────────────────────────────────────────────────

const stockInfoSchema = new mongoose.Schema(
  {
    date:         { type: Date, default: Date.now },
    add_stock:    { type: Number },
    buy_price:    { type: String },
    invoice:      { type: String },
    handler_name: { type: String },
    location:     { type: String },
    stock_images: { type: Array },
    notes:        { type: String },
  },
  { _id: false }
);

const stockOfflineSchema = new mongoose.Schema(
  {
    date:             { type: Date, default: Date.now },
    stock:            { type: Number },
    customer_details: { type: String },
    handler_name:     { type: String },
    location:         { type: String },
    notes:            { type: String },
  },
  { _id: false }
);

// ─── NEW: Material issuance log entry ─────────────────────────────────────────
// Lightweight snapshot stored on the product so the store manager can see
// all issuances from the product detail page without joining material_issue.
const materialIssueLogSchema = new mongoose.Schema(
  {
    issue_id:    { type: mongoose.Schema.Types.ObjectId, ref: "material_issue" },
    issue_no:    { type: String },
    job_no:      { type: String },
    issued_qty:  { type: Number },
    issued_to:   { type: String },              // employee name (snapshot)
    issued_by:   { type: String },              // manager name  (snapshot)
    issued_at:   { type: Date, default: Date.now },
    returned_qty:{ type: Number, default: null },
    unit:        { type: String, default: "sqft" },
    notes:       { type: String, default: "" },
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

      // ── Stock (unchanged) ───────────────────────────────────────────────────
      stock_count:   { type: Number },
      stocks_status: { type: String },
      stock_info:    [stockInfoSchema],
      stock_offline: [stockOfflineSchema],

      // ── Images (unchanged) ──────────────────────────────────────────────────
      images: { type: Array },

      // ── NEW: Material issuance log (print jobs only) ─────────────────────────
      // Separate from stock_offline so print-job issuances don't pollute
      // regular sales/manual stock-out records.
      material_issues: {
        type:    [materialIssueLogSchema],
        default: [],
      },

      // ── NEW: Derived material stats (updated on every issue/return) ──────────
      material_stats: {
        total_issued_qty:   { type: Number, default: 0 },  // cumulative sqft issued
        total_returned_qty: { type: Number, default: 0 },  // cumulative sqft returned
        total_wastage_qty:  { type: Number, default: 0 },  // cumulative wastage
        avg_wastage_pct:    { type: Number, default: 0 },  // rolling average
        issue_count:        { type: Number, default: 0 },  // total number of issuances
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
MIGRATION NOTE
=============================================================================
Existing documents are unaffected — material_issues defaults to [] and
material_stats defaults to zeroed values. No migration script required.

The material_issue controller's decrementStock() / incrementStock() helpers
write to stock_offline / stock_info (existing pattern) AND push a snapshot
into material_issues so the product page can show issuance history without
a separate join.

To populate material_stats you can run a one-time aggregation:

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
=============================================================================
*/