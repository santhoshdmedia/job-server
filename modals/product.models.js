const { default: mongoose } = require("mongoose");

const UNIT_ENUM      = ["sqft", "sqm", "feet", "meters", "pcs", "kg", "rolls"];
const SIZE_UNIT_ENUM = ["inches", "feet", "cm", "meters", "mm"];

const unitQtySchema = new mongoose.Schema(
  {
    qty:  { type: Number, default: 0 },
    unit: { type: String, enum: UNIT_ENUM, default: "pcs" },
  },
  { _id: false }
);

// ✅ FIX: width and height now each have their own unit field
const sizeSchema = new mongoose.Schema(
  {
    width:       { type: Number, default: null },
    width_unit:  { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
    height:      { type: Number, default: null },
    height_unit: { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
    // Kept for backward-compat reads; will no longer be written for new docs
    unit:        { type: String, enum: SIZE_UNIT_ENUM, default: "feet" },
  },
  { _id: false }
);

// ✅ invoice_date field present so it is never silently stripped
const stockInfoSchema = new mongoose.Schema(
  {
    date:         { type: Date,   default: Date.now },
    invoice_date: { type: Date,   default: null },
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

const unitStockSummarySchema = new mongoose.Schema(
  {
    unit:      { type: String, enum: UNIT_ENUM },
    total_in:  { type: Number, default: 0 },
    total_out: { type: Number, default: 0 },
    net_stock: { type: Number, default: 0 },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name:             { type: String, required: true },

    // No strict enum — frontend may send any string value
    type:             { type: String },

    // HSN code field kept in DB (existing data), just not shown in UI anymore
    HSNcode_time:     { type: String },
    product_code:     { type: String },
    product_codeS_NO: { type: String },
    Vendor_Code:      { type: String },
    seo_url:          { type: String },

    material_brand: {
      type:    String,
      default: "",
      trim:    true,
    },

    size: {
      type:    sizeSchema,
      default: null,
    },

    MRP_price:               { type: String },
    customer_product_price:  { type: String },
    Deler_product_price:     { type: String },
    corporate_product_price: { type: String },

    stock_count:   { type: Number },
    stocks_status: { type: String },
    stock_info:    [stockInfoSchema],
    stock_offline: [stockOfflineSchema],

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

    images: { type: Array },

    is_visible: { type: Boolean, default: false },
    is_cloned:  { type: Boolean, default: false },
    parent_product_id: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "product",
      default: null,
    },

    category_details:     { type: mongoose.Schema.Types.ObjectId, ref: "main_category" },
    sub_category_details: { type: mongoose.Schema.Types.ObjectId, ref: "sub_category" },
    vendor_details:       { type: mongoose.Schema.Types.ObjectId, ref: "vendor" },

    variants:       { type: Array, default: [] },
    variants_price: { type: Array, default: [] },

    material_issues: {
      type:    [materialIssueLogSchema],
      default: [],
    },

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
    timestamps: true,
  }
);

module.exports = mongoose.model("product", productSchema);