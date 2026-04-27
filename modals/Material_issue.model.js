// ==================== MATERIAL ISSUE MODEL ====================
// Tracks flex roll / material issuance from store manager to employee,
// and the subsequent return + wastage performance review.

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate required material quantity based on job dimensions + margins.
 *
 * @param {number} width_ft        - Job width in feet
 * @param {number} height_ft       - Job height in feet
 * @param {number} margin_top_in   - Top margin in inches (default 4)
 * @param {number} margin_bottom_in - Bottom margin in inches (default 3)
 * @param {number} wastage_buffer_pct - Extra wastage % to add (default 20)
 * @returns {{ required_sqft, job_sqft, margin_sqft, with_buffer_sqft }}
 */
const calculateRequired = ({
  width_ft,
  height_ft,
  margin_top_in    = 4,
  margin_bottom_in = 3,
  wastage_buffer_pct = 20,
}) => {
  const margin_ft     = (margin_top_in + margin_bottom_in) / 12;   // inches → feet
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
 *
 * Thresholds:
 *   ≤ 10%  → good
 *   ≤ 20%  → acceptable   (known average)
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
    width:  { type: Number, required: true, min: 0 },   // in feet
    height: { type: Number, required: true, min: 0 },   // in feet
    unit:   { type: String, default: "ft" },             // ft | m | sqft
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Calculation Breakdown
// Stored at issue-time so the report is immutable even if formula changes.
// ─────────────────────────────────────────────────────────────────────────────
const calculationSchema = new Schema(
  {
    job_sqft:            { type: Number, default: 0 },  // pure print area
    margin_sqft:         { type: Number, default: 0 },  // top+bottom margin area
    gross_sqft:          { type: Number, default: 0 },  // job + margin, no buffer
    wastage_buffer_pct:  { type: Number, default: 20 }, // % buffer added
    buffer_sqft:         { type: Number, default: 0 },  // gross × buffer %
    required_sqft:       { type: Number, default: 0 },  // gross + buffer (suggested issue qty)
    margin_top_inches:   { type: Number, default: 4 },
    margin_bottom_inches:{ type: Number, default: 3 },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Return Entry
// ─────────────────────────────────────────────────────────────────────────────
const returnSchema = new Schema(
  {
    returned_qty:   { type: Number, required: true, min: 0 }, // sqft returned to store
    returned_at:    { type: Date,   default: Date.now },
    returned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Wastage breakdown ────────────────────────────────────────────────────
    actual_used_qty:      { type: Number, default: 0 },  // issued - returned
    expected_used_qty:    { type: Number, default: 0 },  // calculation.gross_sqft
    actual_wastage_qty:   { type: Number, default: 0 },  // actual_used - job_sqft
    expected_wastage_qty: { type: Number, default: 0 },  // calculation.gross_sqft - job_sqft
    wastage_ratio_pct:    { type: Number, default: 0 },  // (actual_wastage / issued) × 100
    saved_qty:            { type: Number, default: 0 },  // returned > 0 → material saved

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
        "margin_trim",       // normal top/bottom trim
        "misprint",          // print error, had to redo
        "roll_end",          // end of roll leftover
        "color_calibration", // test print for color matching
        "customer_change",   // customer changed spec mid-job
        "equipment_fault",   // printer jam / head issue
        "other",
      ],
      default: "margin_trim",
    },
    wastage_reason_notes: { type: String, default: "" },

    // ── Manager review ───────────────────────────────────────────────────────
    manager_reviewed:   { type: Boolean, default: false },
    manager_review_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },
    manager_review_at:    { type: Date,   default: null },
    manager_notes:        { type: String, default: "" },
    is_flagged:           { type: Boolean, default: false }, // auto-true when high_wastage
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Schema: Material Issue
// ─────────────────────────────────────────────────────────────────────────────
const materialIssueSchema = new Schema(
  {
    // ── Issue reference ──────────────────────────────────────────────────────
    issue_no: { type: String, unique: true, index: true }, // e.g. MI0001

    // ── Linked job ───────────────────────────────────────────────────────────
    job_id:  { type: Schema.Types.ObjectId, ref: "job", required: true, index: true },
    job_no:  { type: String, default: "" },

    // ── Cart item reference (which specific item in the job this is for) ─────
    cart_item_index: { type: Number, default: 0 },         // index in job.cart_items
    cart_item_name:  { type: String, default: "" },        // snapshot of product_name

    // ── Material (product = flex roll from your product collection) ───────────
    material: {
      product_id:   { type: Schema.Types.ObjectId, ref: "product", required: true },
      product_name: { type: String, default: "" },          // snapshot
      unit:         { type: String, default: "sqft" },      // sqft | meters | rft
    },

    // ── Issuance ─────────────────────────────────────────────────────────────
    issued_qty:     { type: Number, required: true, min: 0.01 }, // actual qty cut from roll
    suggested_qty:  { type: Number, default: 0 },                // system-calculated suggestion
    issued_at:      { type: Date,   default: Date.now },

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

    // ── Job dimensions (used for calculation) ────────────────────────────────
    dimensions: { type: dimensionsSchema, required: true },

    // ── System calculation breakdown (frozen at issue time) ──────────────────
    calculation: { type: calculationSchema, default: () => ({}) },

    // ── Notes at issuance ────────────────────────────────────────────────────
    issue_notes: { type: String, default: "" },

    // ── Return (filled after job is done) ────────────────────────────────────
    return: { type: returnSchema, default: null },

    // ── Status lifecycle ─────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["issued", "returned", "partial_return", "no_return"],
      default: "issued",
      index:   true,
    },

    // ── Soft delete ──────────────────────────────────────────────────────────
    is_deleted: { type: Boolean, default: false },
  },
  {
    collection: "material_issue",
    timestamps: true,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes for common queries
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
// Static: Calculate required material (expose formula to controller)
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.calculateRequired = calculateRequired;

// ─────────────────────────────────────────────────────────────────────────────
// Static: Rate performance (expose to controller)
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.ratePerformance = ratePerformance;

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
  const performance      = ratePerformance(wastage_ratio);

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
  manager_notes  = "",
  override_rating = null,  // manager can override auto-rating if context warrants
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