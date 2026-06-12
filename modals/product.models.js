const { default: mongoose } = require("mongoose");

const UNIT_ENUM      = ["sqft", "sqm", "feet", "meters", "pcs", "kg", "rolls"];
const SIZE_UNIT_ENUM = ["inches", "feet", "cm", "meters", "mm"];

// ─── Shared sub-schemas ───────────────────────────────────────────────────────

const unitQtySchema = new mongoose.Schema(
  {
    qty:  { type: Number, default: 0 },
    unit: { type: String, enum: UNIT_ENUM, default: "pcs" },
  },
  { _id: false }
);

const sizeSchema = new mongoose.Schema(
  {
    width:       { type: Number, default: null },
    width_unit:  { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
    height:      { type: Number, default: null },
    height_unit: { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
    // kept for backward-compat reads on old documents
    unit:        { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
  },
  { _id: false }
);

// ─── Stock IN entry ───────────────────────────────────────────────────────────

const stockInfoSchema = new mongoose.Schema(
  {
    date:         { type: Date,   default: Date.now },
    invoice_date: { type: Date,   default: null },
    add_stock:    { type: Number, default: 0 },
    unit_qty:     { type: unitQtySchema, default: () => ({ qty: 0, unit: "pcs" }) },
    buy_price:    { type: String },
    invoice:      { type: String },
    handler_name: { type: String },
    location:     { type: String },
    stock_images: { type: Array,  default: [] },
    notes:        { type: String },
  },
  { _id: false }
);

// ─── Stock OUT entry ──────────────────────────────────────────────────────────
// Each OUT entry now records who took it, what job it went to,
// and the remaining area on THIS product after the deduction.

const stockOfflineSchema = new mongoose.Schema(
  {
    date:             { type: Date,   default: Date.now },
    stock:            { type: Number, default: 0 },
    unit_qty:         { type: unitQtySchema, default: () => ({ qty: 0, unit: "pcs" }) },

    // ── Who took it ──────────────────────────────────────────────────────────
    taken_by:         { type: String, default: "" },   // person name / employee id
    customer_details: { type: String, default: "" },   // customer / job description
    job_no:           { type: String, default: "" },   // linked job/work-order number

    handler_name:     { type: String, default: "" },   // who processed the OUT
    location:         { type: String, default: "" },   // where it went

    // ── Area snapshot (only set when primary_unit is area-based) ─────────────
    // area_used:      how much area was consumed in THIS out-entry
    // remaining_area: remaining area on this product AFTER this entry
    area_used:        { type: Number, default: null },
    remaining_area:   { type: Number, default: null },
    area_unit:        { type: String, enum: UNIT_ENUM, default: null },

    notes:            { type: String, default: "" },
  },
  { _id: false }
);

// ─── Material issue log (linked from material_issue collection) ───────────────

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

// ─── Per-unit running totals ──────────────────────────────────────────────────

const unitStockSummarySchema = new mongoose.Schema(
  {
    unit:      { type: String, enum: UNIT_ENUM },
    total_in:  { type: Number, default: 0 },
    total_out: { type: Number, default: 0 },
    net_stock: { type: Number, default: 0 },
  },
  { _id: false }
);

// ─── Allocation record ────────────────────────────────────────────────────────
// Tracks every "piece" of this product that has been assigned/consumed.
// Works for both area-based and count-based units.

const allocationSchema = new mongoose.Schema(
  {
    allocated_at:   { type: Date,   default: Date.now },
    allocated_by:   { type: String, default: "" },   // staff who did the allocation
    allocated_to:   { type: String, default: "" },   // person / department / customer
    job_no:         { type: String, default: "" },

    // Quantity allocated (qty + unit)
    alloc_unit_qty: { type: unitQtySchema, default: () => ({ qty: 0, unit: "pcs" }) },

    // For area-based products: area consumed in this allocation
    area_consumed:  { type: Number, default: null },
    area_unit:      { type: String, enum: UNIT_ENUM, default: null },

    // Running remaining area AFTER this allocation (null for non-area products)
    remaining_area_after: { type: Number, default: null },

    status: {
      type:    String,
      enum:    ["allocated", "returned", "consumed", "partial_return"],
      default: "allocated",
    },

    returned_qty:   { type: Number, default: null },
    returned_at:    { type: Date,   default: null },
    return_notes:   { type: String, default: "" },

    notes:          { type: String, default: "" },
  },
  { _id: true }   // keep _id so individual allocations can be updated (return flow)
);

// ─── Main Product Schema ──────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
  {
    name:             { type: String, required: true },
    type:             { type: String },

    // codes / identifiers
    product_code:     { type: String },
    product_codeS_NO: { type: String },
    Vendor_Code:      { type: String },
    HSNcode_time:     { type: String },   // kept for existing data

    material_brand:   { type: String, default: "", trim: true },

    size: { type: sizeSchema, default: null },

    // ── Batch fields ──────────────────────────────────────────────────────────
    // When quantity > 1 products are created together they share a batch_id.
    // Every record stores the full list of sibling codes so the batch is
    // recoverable from any single document.
    batch_id: {
      type:    String,   // uuid generated once per creation batch
      default: null,
    },
    calculated_area: {
      type:    Number,   // area of ONE physical unit (e.g. 10.5 sqft); null if not area-based
      default: null,
    },
    product_quantity: {
      type:    Number,   // how many products were created in this batch
      default: 1,
    },
    product_codes: {
      type:    [String], // all sibling codes in this batch
      default: [],
    },

    // ── Area tracking ─────────────────────────────────────────────────────────
    // remaining_area tracks how much area is left on THIS specific product.
    // Starts equal to calculated_area, decremented by each stock-OUT / allocation.
    // null for non-area-based products.
    remaining_area: {
      type:    Number,
      default: null,
    },
    area_unit: {
      type:    String,
      enum:    UNIT_ENUM,
      default: null,
    },

    // ── Stock ─────────────────────────────────────────────────────────────────
    stock_count:    { type: Number, default: 0 },
    stocks_status:  { type: String, default: "In Stock" },
    stock_info:     { type: [stockInfoSchema],   default: [] },   // IN  entries
    stock_offline:  { type: [stockOfflineSchema], default: [] },  // OUT entries

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

    // ── Allocations ───────────────────────────────────────────────────────────
    // Fine-grained record of who took what from this specific product.
    allocations: {
      type:    [allocationSchema],
      default: [],
    },
    // Quick summary counters (updated on every allocation change)
    allocation_stats: {
      total_allocated_qty:  { type: Number, default: 0 },
      total_returned_qty:   { type: Number, default: 0 },
      total_consumed_qty:   { type: Number, default: 0 },
      total_allocated_area: { type: Number, default: null },
      total_returned_area:  { type: Number, default: null },
      allocation_count:     { type: Number, default: 0 },
      stats_unit:           { type: String, enum: UNIT_ENUM, default: "pcs" },
    },

    // ── Material issues (from dedicated issue module) ─────────────────────────
    material_issues: { type: [materialIssueLogSchema], default: [] },
    material_stats: {
      total_issued_qty:   { type: Number, default: 0 },
      total_returned_qty: { type: Number, default: 0 },
      total_wastage_qty:  { type: Number, default: 0 },
      avg_wastage_pct:    { type: Number, default: 0 },
      issue_count:        { type: Number, default: 0 },
      stats_unit:         { type: String, enum: UNIT_ENUM, default: "sqft" },
      _last_updated:      { type: Date,   default: null },
    },

    images:     { type: Array, default: [] },
    is_visible: { type: Boolean, default: false },

    // soft-delete / clone support
    is_cloned:         { type: Boolean, default: false },
    parent_product_id: { type: mongoose.Schema.Types.ObjectId, ref: "product", default: null },
  },
  {
    collection: "product",
    timestamps: true,
  }
);

// ─── Indexes for fast batch and area queries ──────────────────────────────────
productSchema.index({ batch_id: 1 });
productSchema.index({ product_code: 1 });
productSchema.index({ remaining_area: 1 });

module.exports = mongoose.model("product", productSchema);