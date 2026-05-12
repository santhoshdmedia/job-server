// ==================== MATERIAL ISSUE MODEL ====================
// Tracks flex roll / material issuance from store manager to employee,
// the subsequent return + wastage performance review,
// and production metadata (machine, ink, duration).

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate required material quantity based on job dimensions + margins.
 */
const calculateRequired = ({
  width_ft,
  height_ft,
  margin_top_in      = 4,
  margin_bottom_in   = 3,
  wastage_buffer_pct = 20,
}) => {
  const margin_ft     = (margin_top_in + margin_bottom_in) / 12;
  const total_height  = height_ft + margin_ft;
  const job_sqft      = width_ft * height_ft;
  const margin_sqft   = width_ft * margin_ft;
  const gross_sqft    = width_ft * total_height;
  const buffer_sqft   = gross_sqft * (wastage_buffer_pct / 100);
  const required_sqft = parseFloat((gross_sqft + buffer_sqft).toFixed(4));

  return {
    job_sqft:         parseFloat(job_sqft.toFixed(4)),
    margin_sqft:      parseFloat(margin_sqft.toFixed(4)),
    gross_sqft:       parseFloat(gross_sqft.toFixed(4)),
    with_buffer_sqft: required_sqft,
    required_sqft,
  };
};

/**
 * Determine employee performance based on wastage ratio.
 *   ≤ 10%  → good
 *   ≤ 20%  → acceptable
 *   > 20%  → high_wastage (flagged)
 */
const ratePerformance = (wastage_ratio_pct) => {
  if (wastage_ratio_pct <= 10) return "good";
  if (wastage_ratio_pct <= 20) return "acceptable";
  return "high_wastage";
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Job Dimensions
// ─────────────────────────────────────────────────────────────────────────────
const dimensionsSchema = new Schema(
  {
    width:  { type: Number, required: true, min: 0 },
    height: { type: Number, required: true, min: 0 },
    unit:   { type: String, default: "ft" },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Calculation Breakdown (frozen at issue time)
// ─────────────────────────────────────────────────────────────────────────────
const calculationSchema = new Schema(
  {
    job_sqft:             { type: Number, default: 0 },
    margin_sqft:          { type: Number, default: 0 },
    gross_sqft:           { type: Number, default: 0 },
    wastage_buffer_pct:   { type: Number, default: 20 },
    buffer_sqft:          { type: Number, default: 0 },
    required_sqft:        { type: Number, default: 0 },
    margin_top_inches:    { type: Number, default: 4 },
    margin_bottom_inches: { type: Number, default: 3 },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Ink Usage Entry
// ─────────────────────────────────────────────────────────────────────────────
const inkUsageSchema = new Schema(
  {
    color:    { type: String, default: "" },  // e.g. "Cyan", "Magenta", "Black"
    quantity: { type: Number, default: 0 },   // in ml
    unit:     { type: String, default: "ml" },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Return Entry
// ─────────────────────────────────────────────────────────────────────────────
const returnSchema = new Schema(
  {
    returned_qty:   { type: Number, required: true, min: 0 },
    returned_at:    { type: Date, default: Date.now },
    returned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Wastage breakdown ────────────────────────────────────────────────────
    actual_used_qty:      { type: Number, default: 0 },
    expected_used_qty:    { type: Number, default: 0 },
    actual_wastage_qty:   { type: Number, default: 0 },
    expected_wastage_qty: { type: Number, default: 0 },
    wastage_ratio_pct:    { type: Number, default: 0 },
    saved_qty:            { type: Number, default: 0 },

    // ── Performance ──────────────────────────────────────────────────────────
    performance_rating: {
      type:    String,
      enum:    ["good", "acceptable", "high_wastage"],
      default: "acceptable",
    },

    // ── Wastage reasons (employee self-report) ───────────────────────────────
    wastage_reason: {
      type: String,
      enum: [
        "margin_trim",
        "misprint",
        "roll_end",
        "color_calibration",
        "customer_change",
        "equipment_fault",
        "other",
      ],
      default: "margin_trim",
    },
    wastage_reason_notes: { type: String, default: "" },

    // ── Manager review ───────────────────────────────────────────────────────
    manager_reviewed:  { type: Boolean, default: false },
    manager_review_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },
    manager_review_at: { type: Date, default: null },
    manager_notes:     { type: String, default: "" },
    is_flagged:        { type: Boolean, default: false },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Schema: Material Issue
// ─────────────────────────────────────────────────────────────────────────────
const materialIssueSchema = new Schema(
  {
    // ── Issue reference ──────────────────────────────────────────────────────
    issue_no: { type: String, unique: true, index: true },

    // ── Calc mode (sqft | server) — set at issue time, drives breakdown display
    calc_mode: { type: String, enum: ["sqft", "server"], default: "server" },
    sq_ft:     { type: Number, default: null }, // cart sq_ft, present when calc_mode === "sqft"

    // ── Linked job ───────────────────────────────────────────────────────────
    job_id:  { type: Schema.Types.ObjectId, ref: "job", required: true, index: true },
    job_no:  { type: String, default: "" },

    // ── Cart item reference ───────────────────────────────────────────────────
    cart_item_index: { type: Number, default: 0 },
    cart_item_name:  { type: String, default: "" },

    // ── Material ──────────────────────────────────────────────────────────────
    material: {
      product_id:   { type: Schema.Types.ObjectId, ref: "product", required: true },
      product_name: { type: String, default: "" },
      unit:         { type: String, default: "sqft" },
    },

    // ── Issuance ──────────────────────────────────────────────────────────────
    issued_qty:    { type: Number, required: true, min: 0.01 },
    suggested_qty: { type: Number, default: 0 },
    issued_at:     { type: Date, default: Date.now },

    issued_to: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", required: true },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    issued_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", required: true },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Job dimensions ────────────────────────────────────────────────────────
    dimensions: { type: dimensionsSchema, required: true },

    // ── System calculation breakdown (frozen at issue time) ───────────────────
    calculation: { type: calculationSchema, default: () => ({}) },

    // ── Issue notes ───────────────────────────────────────────────────────────
    issue_notes: { type: String, default: "" },

    // ── Production metadata (filled when production is completed) ─────────────
    machine_name: { type: String, default: "" },          // e.g. "HP Latex 360"
    ink_used: { type: [inkUsageSchema], default: [] },    // per-colour ink breakdown
    ink_notes: { type: String, default: "" },             // free-text ink note

    // ── Production duration ───────────────────────────────────────────────────
    // Set when production team submits the job via ProductionUploadPanel
    production_started_at:    { type: Date, default: null },
    production_completed_at:  { type: Date, default: null },
    production_duration_seconds: { type: Number, default: 0 },
    production_duration_display: { type: String, default: "00:00:00" },

    // ── Return (filled after job is done) ─────────────────────────────────────
    return: { type: returnSchema, default: null },

    // ── Status lifecycle ──────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["issued", "returned", "partial_return", "no_return"],
      default: "issued",
      index:   true,
    },

    // ── Soft delete ───────────────────────────────────────────────────────────
    is_deleted: { type: Boolean, default: false },
  },
  {
    collection: "material_issue",
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.index({ "issued_to.user_id": 1, createdAt: -1 });
materialIssueSchema.index({ "material.product_id": 1 });
materialIssueSchema.index({ status: 1, createdAt: -1 });
materialIssueSchema.index({ "return.is_flagged": 1 });

// ─────────────────────────────────────────────────────────────────────────────
// Static: Auto-generate issue number  MI0001, MI0002 …
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.generateIssueNo = async function () {
  const prefix = "MI";
  const last   = await this.findOne({ issue_no: new RegExp(`^${prefix}\\d+$`) })
    .sort({ issue_no: -1 })
    .select("issue_no")
    .lean();

  let seq = 1;
  if (last) {
    const parsed = parseInt(last.issue_no.replace(prefix, ""), 10);
    if (!isNaN(parsed)) seq = parsed + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Static: Expose formula to controller
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.calculateRequired = calculateRequired;
materialIssueSchema.statics.ratePerformance   = ratePerformance;

// ─────────────────────────────────────────────────────────────────────────────
// Static: Utility — format seconds → "HH:MM:SS"
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.secsToDisplay = (totalSeconds) => {
  const s   = Math.max(0, Math.floor(totalSeconds));
  const h   = String(Math.floor(s / 3600)).padStart(2, "0");
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Instance: Record production completion metadata
// Called from the approveProduction / ProductionUploadPanel submit flow.
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.applyProductionCompletion = function ({
  machine_name              = "",
  ink_used                  = [],
  ink_notes                 = "",
  production_started_at     = null,
  production_completed_at   = null,
  production_duration_seconds = 0,
}) {
  this.machine_name              = machine_name;
  this.ink_used                  = ink_used;
  this.ink_notes                 = ink_notes;
  this.production_started_at     = production_started_at
    ? new Date(production_started_at)
    : null;
  this.production_completed_at   = production_completed_at
    ? new Date(production_completed_at)
    : new Date();

  const secs = parseInt(production_duration_seconds, 10) || 0;
  this.production_duration_seconds = secs;
  this.production_duration_display = this.constructor.secsToDisplay(secs);
};

// ─────────────────────────────────────────────────────────────────────────────
// Instance: Apply return data and compute all wastage fields
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.applyReturn = function ({
  returned_qty,
  wastage_reason       = "margin_trim",
  wastage_reason_notes = "",
  returned_by          = {},
}) {
  const issued  = this.issued_qty;
  const calc    = this.calculation;

  const returned         = Math.max(0, returned_qty);
  const actual_used      = parseFloat((issued - returned).toFixed(4));
  const actual_wastage   = parseFloat((actual_used - calc.job_sqft).toFixed(4));
  const expected_wastage = parseFloat((calc.gross_sqft - calc.job_sqft).toFixed(4));
  const wastage_ratio    = issued > 0
    ? parseFloat(((actual_wastage / issued) * 100).toFixed(2))
    : 0;
  const performance = ratePerformance(wastage_ratio);

  this.return = {
    returned_qty,
    returned_at:          new Date(),
    returned_by,
    actual_used_qty:      actual_used,
    expected_used_qty:    calc.gross_sqft,
    actual_wastage_qty:   Math.max(0, actual_wastage),
    expected_wastage_qty: Math.max(0, expected_wastage),
    wastage_ratio_pct:    wastage_ratio,
    saved_qty:            returned,
    performance_rating:   performance,
    wastage_reason,
    wastage_reason_notes,
    is_flagged:           performance === "high_wastage",
    manager_reviewed:     false,
  };

  this.status = returned_qty > 0 ? "returned" : "no_return";
};

// ─────────────────────────────────────────────────────────────────────────────
// Instance: Apply manager review
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.applyManagerReview = function ({
  manager_by,
  manager_notes   = "",
  override_rating = null,
}) {
  if (!this.return) throw new Error("Cannot review before return is recorded.");

  this.return.manager_reviewed  = true;
  this.return.manager_review_by = manager_by;
  this.return.manager_review_at = new Date();
  this.return.manager_notes     = manager_notes;

  if (override_rating && ["good", "acceptable", "high_wastage"].includes(override_rating)) {
    this.return.performance_rating = override_rating;
    this.return.is_flagged         = override_rating === "high_wastage";
  }
};

module.exports =
  mongoose.models.material_issue ||
  mongoose.model("material_issue", materialIssueSchema);