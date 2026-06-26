// ==================== MATERIAL ISSUE MODEL ====================
// Tracks flex roll / material issuance from store manager to employee,
// the subsequent return + wastage performance review,
// and production metadata (machine, ink, duration).
//
// KEY CHANGES (v3):
//  • pickup_assignment sub-schema added
//    – assigned_to.user_id refs admin_users (required)
//    – delivery_to enum: "dmedia_office" | "factory" | "customer"
//    – pickup_time (Date, required)
//    – notes, assigned_by, assigned_at
//  • printing_dimensions + media_dimensions stored on the record
//  • calc_mode "dimensions" added (frontend two-dim flow)
//  • design_file_id links an issue to a specific per-item design file
//  • outsource_type enum kept open (string) so frontend can pass any value

const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate required material quantity based on job dimensions + margins.
 * Used only in calc_mode === "server".
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
// Sub-Schema: Dimension Record (printing or media)
// ─────────────────────────────────────────────────────────────────────────────
const dimensionDetailSchema = new Schema(
  {
    width:  { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    unit:   { type: String, default: "ft" }, // ft | in | m | cm
    sqft:   { type: Number, default: 0 },    // pre-converted sq ft
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Job Dimensions (legacy — width/height in ft for server calc)
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
    // server-mode fields
    job_sqft:             { type: Number, default: 0 },
    margin_sqft:          { type: Number, default: 0 },
    gross_sqft:           { type: Number, default: 0 },
    margin_top_inches:    { type: Number, default: 0 },
    margin_bottom_inches: { type: Number, default: 0 },

    // dimensions-mode fields
    print_sqft:   { type: Number, default: 0 },
    media_sqft:   { type: Number, default: 0 },
    wastage_sqft: { type: Number, default: 0 },

    // common
    wastage_buffer_pct: { type: Number, default: 0 },
    buffer_sqft:        { type: Number, default: 0 },
    required_sqft:      { type: Number, default: 0 },
  },
  { _id: false }
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Ink Usage Entry
// ─────────────────────────────────────────────────────────────────────────────
const inkUsageSchema = new Schema(
  {
    color:    { type: String, default: "" },
    quantity: { type: Number, default: 0 },
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

    actual_used_qty:      { type: Number, default: 0 },
    expected_used_qty:    { type: Number, default: 0 },
    actual_wastage_qty:   { type: Number, default: 0 },
    expected_wastage_qty: { type: Number, default: 0 },
    wastage_ratio_pct:    { type: Number, default: 0 },
    saved_qty:            { type: Number, default: 0 },

    performance_rating: {
      type:    String,
      enum:    ["good", "acceptable", "high_wastage"],
      default: "acceptable",
    },

    wastage_reason: {
      type: String,
      enum: [
        "margin_trim", "misprint", "roll_end", "color_calibration",
        "customer_change", "equipment_fault", "other",
      ],
      default: "margin_trim",
    },
    wastage_reason_notes: { type: String, default: "" },

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
// Sub-Schema: Pickup Assignment (NEW v3)
//
// Records who should collect the outsourced item from the vendor,
// where to deliver it, and when.
//
// Fields:
//   assigned_to.user_id  — ObjectId ref to admin_users (required)
//   assigned_to.name     — denormalised for fast display
//   assigned_to.role     — denormalised role string
//   delivery_to          — one of three drop-off points
//   pickup_time          — scheduled collection datetime
//   notes                — optional handling instructions
//   assigned_by          — who created this assignment (store manager / super admin)
//   assigned_at          — wall-clock timestamp of assignment creation
//   status               — lifecycle of the pickup task
// ─────────────────────────────────────────────────────────────────────────────
const pickupAssignmentSchema = new Schema(
  {
    // ── Person collecting from vendor ────────────────────────────────────────
    assigned_to: {
      user_id: {
        type:     Schema.Types.ObjectId,
        ref:      "admin_users",
        required: true,
      },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },

    // ── Where to deliver after pickup ────────────────────────────────────────
    // "dmedia_office" — main office reception
    // "factory"       — production floor
    // "customer"      — direct delivery to customer site
    delivery_to: {
      type:     String,
      enum:     ["dmedia_office", "factory", "customer"],
      required: true,
    },

    // ── When to collect ──────────────────────────────────────────────────────
    pickup_time: { type: Date, required: true },

    // ── Optional instructions ────────────────────────────────────────────────
    notes: { type: String, default: "" },

    // ── Audit: who created this assignment ───────────────────────────────────
    assigned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    assigned_at: { type: Date, default: Date.now },

    // ── Pickup lifecycle ─────────────────────────────────────────────────────
    // "pending"    — assigned, not yet collected
    // "collected"  — person has picked up from vendor
    // "delivered"  — item has reached the delivery_to location
    // "cancelled"  — assignment was cancelled
    status: {
      type:    String,
      enum:    ["pending", "collected", "delivered", "cancelled"],
      default: "pending",
      index:   true,
    },

    collected_at: { type: Date, default: null },
    delivered_at: { type: Date, default: null },
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

    // ── Calc mode ────────────────────────────────────────────────────────────
    //    "server"     — legacy: width/height → server calculates sqft
    //    "sqft"       — cart provided a flat sqft number
    //    "dimensions" — frontend provides printing + media dimensions
    //    "outsource"  — outsourced; no material deducted from stock
    calc_mode: {
      type:    String,
      enum:    ["sqft", "server", "dimensions", "outsource"],
      default: "server",
    },

    // flat sq_ft when calc_mode === "sqft"
    sq_ft: { type: Number, default: null },

    // ── Linked job ───────────────────────────────────────────────────────────
    job_id:  { type: Schema.Types.ObjectId, ref: "job", required: true, index: true },
    job_no:  { type: String, default: "" },

    // ── Cart item reference ──────────────────────────────────────────────────
    cart_item_index: { type: Number, default: 0 },
    cart_item_name:  { type: String, default: "" },
    cart_item_id:    { type: String, default: "" },

    // ── Design file linkage ──────────────────────────────────────────────────
    design_file_id:    { type: Schema.Types.ObjectId, default: null },
    design_file_label: { type: String, default: "" },

    // ── Material ─────────────────────────────────────────────────────────────
    material: {
      product_id:   { type: Schema.Types.ObjectId, ref: "product", default: null },
      product_name: { type: String, default: "" },
      unit:         { type: String, default: "sqft" },
    },

    // ── Issuance ─────────────────────────────────────────────────────────────
    issued_qty:    { type: Number, required: true, min: 0 },
    suggested_qty: { type: Number, default: 0 },
    issued_at:     { type: Date, default: Date.now },

    issued_to: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    issued_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", required: true },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Dimensions ───────────────────────────────────────────────────────────
    dimensions: {
      type: dimensionsSchema,
      default: () => ({ width: 0, height: 0, unit: "ft" }),
    },
    printing_dimensions: { type: dimensionDetailSchema, default: null },
    media_dimensions:    { type: dimensionDetailSchema, default: null },
    wastage_sqft:        { type: Number, default: 0 },

    // ── Calculation snapshot ─────────────────────────────────────────────────
    calculation: { type: calculationSchema, default: () => ({}) },

    // ── Notes ────────────────────────────────────────────────────────────────
    issue_notes: { type: String, default: "" },

    // ── Outsource ────────────────────────────────────────────────────────────
    outsource_type:   { type: String, default: "none", index: true },
    outsource_vendor: { type: String, default: "" },

    // ── Pickup Assignment (NEW) ───────────────────────────────────────────────
    // Only populated for calc_mode === "outsource" records.
    // null  → not yet assigned
    // object → assignment exists (see pickupAssignmentSchema above)
    pickup_assignment: { type: pickupAssignmentSchema, default: null },

    // ── Production metadata ──────────────────────────────────────────────────
    machine_name: { type: String, default: "" },
    ink_used:     { type: [inkUsageSchema], default: [] },
    ink_notes:    { type: String, default: "" },

    production_started_at:       { type: Date, default: null },
    production_completed_at:     { type: Date, default: null },
    production_duration_seconds: { type: Number, default: 0 },
    production_duration_display: { type: String, default: "00:00:00" },

    // ── Return ───────────────────────────────────────────────────────────────
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
// Indexes
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.index({ "issued_to.user_id": 1, createdAt: -1 });
materialIssueSchema.index({ "material.product_id": 1 });
materialIssueSchema.index({ status: 1, createdAt: -1 });
materialIssueSchema.index({ "return.is_flagged": 1 });
materialIssueSchema.index({ design_file_id: 1 });
materialIssueSchema.index({ cart_item_id: 1 });
// Pickup-specific indexes
materialIssueSchema.index({ "pickup_assignment.assigned_to.user_id": 1 });
materialIssueSchema.index({ "pickup_assignment.status": 1, "pickup_assignment.pickup_time": 1 });
materialIssueSchema.index({ calc_mode: 1, "pickup_assignment.status": 1 });

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
// Static: Expose formula helpers to controller
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.statics.calculateRequired = calculateRequired;
materialIssueSchema.statics.ratePerformance   = ratePerformance;

// ─────────────────────────────────────────────────────────────────────────────
// Static: Format seconds → "HH:MM:SS"
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
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.applyProductionCompletion = function ({
  machine_name              = "",
  ink_used                  = [],
  ink_notes                 = "",
  production_started_at     = null,
  production_completed_at   = null,
  production_duration_seconds = 0,
}) {
  this.machine_name            = machine_name;
  this.ink_used                = ink_used;
  this.ink_notes               = ink_notes;
  this.production_started_at   = production_started_at  ? new Date(production_started_at)  : null;
  this.production_completed_at = production_completed_at ? new Date(production_completed_at) : new Date();

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
  const netPrintArea     = calc.print_sqft || calc.job_sqft || 0;
  const actual_wastage   = parseFloat((actual_used - netPrintArea).toFixed(4));
  const expected_wastage = parseFloat(((calc.gross_sqft || calc.media_sqft || 0) - netPrintArea).toFixed(4));
  const wastage_ratio    = issued > 0
    ? parseFloat(((actual_wastage / issued) * 100).toFixed(2))
    : 0;
  const performance = ratePerformance(wastage_ratio);

  this.return = {
    returned_qty,
    returned_at:          new Date(),
    returned_by,
    actual_used_qty:      actual_used,
    expected_used_qty:    calc.gross_sqft || calc.media_sqft || 0,
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
// Instance: Apply pickup assignment
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.applyPickupAssignment = function ({
  assigned_to,
  delivery_to,
  pickup_time,
  notes       = "",
  assigned_by = {},
}) {
  if (this.calc_mode !== "outsource") {
    throw new Error("Pickup assignment is only valid for outsource issues.");
  }
  if (!assigned_to?.user_id) {
    throw new Error("assigned_to.user_id is required.");
  }
  if (!["dmedia_office", "factory", "customer"].includes(delivery_to)) {
    throw new Error("delivery_to must be one of: dmedia_office, factory, customer.");
  }
  if (!pickup_time || new Date(pickup_time) <= new Date()) {
    throw new Error("pickup_time must be a future date.");
  }

  this.pickup_assignment = {
    assigned_to: {
      user_id: assigned_to.user_id,
      name:    assigned_to.name || "",
      role:    assigned_to.role || "",
    },
    delivery_to,
    pickup_time:  new Date(pickup_time),
    notes:        notes.trim(),
    assigned_by: {
      user_id: assigned_by.user_id || null,
      name:    assigned_by.name    || "",
      role:    assigned_by.role    || "",
    },
    assigned_at: new Date(),
    status:      "pending",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Instance: Update pickup status (collected / delivered / cancelled)
// ─────────────────────────────────────────────────────────────────────────────
materialIssueSchema.methods.updatePickupStatus = function (newStatus) {
  const allowed = ["collected", "delivered", "cancelled"];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid pickup status. Must be one of: ${allowed.join(", ")}`);
  }
  if (!this.pickup_assignment) {
    throw new Error("No pickup assignment found on this issue.");
  }

  this.pickup_assignment.status = newStatus;
  if (newStatus === "collected") this.pickup_assignment.collected_at = new Date();
  if (newStatus === "delivered") this.pickup_assignment.delivered_at = new Date();
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