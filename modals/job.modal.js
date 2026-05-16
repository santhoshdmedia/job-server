const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────
const secsToDisplay = (totalSeconds) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Work Session
// ─────────────────────────────────────────────────────────────────────────────
const workSessionSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    name:    { type: String, default: "" },
    role:    { type: String, default: "" },

    session_start: { type: Date, required: true },
    session_end:   { type: Date, default: null },

    duration_seconds: { type: Number, default: 0 },
    duration_display: { type: String, default: "00:00:00" },

    work_date: { type: String, default: "" },
    notes:     { type: String, default: "" },
  },
  { _id: true, timestamps: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Workflow Stage Entry
// ─────────────────────────────────────────────────────────────────────────────
const workflowStageSchema = new Schema(
  {
    stage:       { type: String, required: true },
    stage_label: { type: String, default: "" },

    handled_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    assigned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    action:       { type: String, default: "assigned" },
    assigned_at:  { type: Date, default: null },
    started_at:   { type: Date, default: null },
    completed_at: { type: Date, default: null },

    work_sessions:          { type: [workSessionSchema], default: [] },
    total_duration_seconds: { type: Number, default: 0 },
    total_duration_display: { type: String, default: "00:00:00" },
    worked_days:            { type: Number, default: 0 },

    daily_summary: [
      {
        date:    { type: String },
        seconds: { type: Number },
        display: { type: String },
        _id: false,
      },
    ],

    notes: { type: String, default: "" },
  },
  { _id: true, timestamps: false },
);

// ─── Recompute totals + daily_summary from closed sessions ────────────────────
workflowStageSchema.methods.recomputeTotals = function () {
  let total = 0;
  const byDay = {};

  for (const sess of this.work_sessions) {
    if (sess.session_start && sess.session_end) {
      const diffMs = new Date(sess.session_end) - new Date(sess.session_start);
      const secs   = Math.max(0, Math.floor(diffMs / 1000));

      sess.duration_seconds = secs;
      sess.duration_display = secsToDisplay(secs);
      total += secs;

      const day = sess.work_date || new Date(sess.session_start).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + secs;
    }
  }

  this.total_duration_seconds = total;
  this.total_duration_display = secsToDisplay(total);
  this.worked_days            = Object.keys(byDay).length;
  this.daily_summary          = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, secs]) => ({ date, seconds: secs, display: secsToDisplay(secs) }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Supporting Sub-Schemas
// ─────────────────────────────────────────────────────────────────────────────
const addressSchema = new Schema(
  {
    street:  { type: String, default: "" },
    city:    { type: String, default: "" },
    state:   { type: String, default: "" },
    pincode: { type: String, default: "" },
    country: { type: String, default: "India" },
  },
  { _id: false },
);

const jobCartItemSchema = new Schema(
  {
    product_id:     { type: String, default: "" },
    product_name:   { type: String },
    printing_type:  { type: String },
    variation:      { type: String },
    quantity:       { type: Number, min: 1 },
    quantity_type:  { type: String, default: "pcs" },
    price:          { type: Number, min: 0 },
    design_file:    { type: String, default: "" },
    size:           { type: String, default: "" },
    height:         { type: String, default: "" },
    width:          { type: String, default: "" },
    size_unit:      { type: String, default: "" },
    sq_ft:          { type: String, default: "" },
    gst_percentage: { type: Number, default: 0 },
    notes:          { type: String, default: "" },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Job Schema
// ─────────────────────────────────────────────────────────────────────────────
const jobSchema = new Schema(
  {
    order_no: { type: String, default: "", index: true },
    job_no:   { type: String, unique: true, index: true },

    customer_name:  { type: String, default: "" },
    customer_phone: { type: String, default: "" },

    cart_items:              { type: [jobCartItemSchema] },
    delivery_address:        { type: addressSchema },
    estimated_delivery_date: { type: Date },
    order_date:              { type: Date },

    job_status: {
      type:    String,
      default: "draft",
      // draft | accepted | in_progress | on_hold | quality_check |
      // passed | failed | completed | rejected | converted | expired
      // NOTE: ONLY controllers that explicitly own a status transition
      //       should write this field. Session helpers never touch it.
    },
    status_updated_at: { type: Date },

    // ── Live snapshot — synced by pre-save hook from workflow_stages
    current_stage: {
      stage:        { type: String, default: null },
      stage_label:  { type: String, default: "" },
      stage_action: { type: String, default: "assigned" },
      assigned_to: {
        user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
        name:    { type: String, default: "" },
        role:    { type: String, default: "" },
      },
      since:                  { type: Date, default: null },
      total_duration_seconds: { type: Number, default: 0 },
      total_duration_display: { type: String, default: "00:00:00" },
      worked_days:            { type: Number, default: 0 },
    },

    // ── Full stage pipeline with embedded sessions
    workflow_stages: { type: [workflowStageSchema], default: [] },

    // ── Design file
    design_file:             { type: String, default: "" },
    design_drive_link:       { type: String, default: "" },
    design_uploaded_at:      { type: Date },
    design_uploaded_by:      { type: String, default: "" },
    design_duration_seconds: { type: Number, default: 0 },
    design_duration_display: { type: String, default: "00:00:00" },
    design_status:           { type: String, default: "pending" },
    design_rejection_reason: { type: String, default: "" },
    design_approved_at:      { type: Date },
    design_approved_by: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
    },
    design_is_sample: { type: Boolean, default: false },

    // ── Production
    productionimg:         { type: String, default: "" },
    production_status:     { type: String, default: "pending" },
    production_approved_at:{ type: Date },
    production_approved_by:{
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
    },

    // ── Quality Check
    qcimg:                { type: String, default: "" },
    qc_images:            { type: [String], default: [] },
    qc_notes:             { type: String, default: "" },
    qc_status:            { type: String, default: "pending" }, // pending | passed | failed
    qc_rejection_reason:  { type: String, default: "" },
    qc_inspected_by:      { type: String, default: "" },
    qc_inspected_at:      { type: Date },
    qc_duration_seconds:  { type: Number, default: 0 },
    qc_duration_display:  { type: String, default: "00:00:00" },
    qc_approved_at:       { type: Date },
    qc_approved_by: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
    },

    // ── Financials
    subtotal:            { type: Number, default: 0 },
    discount_percentage: { type: Number, default: 0, min: 0, max: 100 },
    discount_amount:     { type: Number, default: 0 },
    taxable_amount:      { type: Number, default: 0 },
    tax_amount:          { type: Number, default: 0 },
    delivery_charges:    { type: Number, default: 0 },
    free_delivery:       { type: Boolean, default: false },
    total_amount:        { type: Number, required: true },
    gst_no:              { type: String, default: "" },
    payment_mode:        { type: String, default: "" },
    payment_amount:      { type: String, default: "" },
    design_charges:      { type: Number, default: 0 },
    valid_until:         { type: Date, required: true },
    notes:               { type: String, default: "" },
    terms_and_conditions:{ type: String, default: "" },

    converted_to_order: { type: Boolean, default: false },
    converted_at:       { type: Date },

    // ── Soft delete
    deletedAt:     { type: Date, default: null },
    deleted_notes: { type: String, default: "" },
    deleted_by: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
    },

    created_by:   { type: String, default: "admin" },
    approved_by:  { type: String, default: "admin" },

    created_by_admin_id: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
      index:   true,
    },
    approved_by_admin_id: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
      index:   true,
    },
  },
  { collection: "job", timestamps: true },
);

// ════════════════════════════════════════════════════════════════════════════
// Pre-save Middleware
// ════════════════════════════════════════════════════════════════════════════

jobSchema.pre("save", function () {
  if (this.isModified("job_status")) {
    this.status_updated_at = new Date();
  }
});

jobSchema.pre("save", function () {
  if (!this.isModified("workflow_stages")) return;

  for (const stageEntry of this.workflow_stages) {
    stageEntry.recomputeTotals();
  }

  // Only auto-sync current_stage when the controller hasn't already set it
  if (this.isModified("current_stage")) return;
  if (!this.workflow_stages.length) return;

  const active =
    [...this.workflow_stages]
      .reverse()
      .find(
        (s) =>
          s.action !== "completed" &&
          s.action !== "rejected" &&
          s.action !== "cancelled",
      ) || this.workflow_stages[this.workflow_stages.length - 1];

  this.current_stage = {
    stage:                  active.stage,
    stage_label:            active.stage_label || "",
    stage_action:           active.action,
    assigned_to:            active.handled_by,
    since:                  active.assigned_at || new Date(),
    total_duration_seconds: active.total_duration_seconds,
    total_duration_display: active.total_duration_display,
    worked_days:            active.worked_days,
  };
});

// ════════════════════════════════════════════════════════════════════════════
// Soft-Delete Query Middleware
// ════════════════════════════════════════════════════════════════════════════

jobSchema.pre(/^find/, function () {
  this.where({ deletedAt: null });
});

jobSchema.query.includeDeleted = function () {
  return this.where({ deletedAt: { $ne: null } });
};

// ════════════════════════════════════════════════════════════════════════════
// Instance Methods
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns the most-recent workflow stage entry for `stageName` that is
 * not yet completed / rejected / cancelled.
 */
jobSchema.methods.getActiveStage = function (stageName) {
  return (
    this.workflow_stages.find(
      (s) =>
        s.stage === stageName &&
        s.action !== "completed" &&
        s.action !== "rejected" &&
        s.action !== "cancelled",
    ) || null
  );
};

/**
 * Opens a new work session on a stage.
 *
 * ⚠️  DOES NOT touch job_status — the calling controller is responsible
 *     for any status change it needs.
 */
jobSchema.methods.openSession = function ({
  stageName,
  stageLabel = "",
  user,
  assignedBy = null,
  notes = "",
}) {
  const now      = new Date();
  const workDate = now.toISOString().slice(0, 10);

  let stageEntry = this.getActiveStage(stageName);

  if (!stageEntry) {
    this.workflow_stages.push({
      stage:       stageName,
      stage_label: stageLabel || stageName,
      handled_by:  { user_id: user.user_id, name: user.name, role: user.role || "" },
      assigned_by: assignedBy || {},
      action:      "in_progress",
      assigned_at: now,
      started_at:  now,
      work_sessions: [],
      notes,
    });
    stageEntry = this.workflow_stages[this.workflow_stages.length - 1];
  } else {
    stageEntry.action = "in_progress";
    if (!stageEntry.started_at) stageEntry.started_at = now;
  }

  // Auto-close any accidentally-left-open session
  for (const s of stageEntry.work_sessions) {
    if (s.session_start && !s.session_end) s.session_end = now;
  }

  stageEntry.work_sessions.push({
    user_id:       user.user_id || null,
    name:          user.name || "",
    role:          user.role || "",
    session_start: now,
    session_end:   null,
    work_date:     workDate,
    notes,
  });

  // ✅ NO job_status change here — controller decides
};

/**
 * Closes the currently open work session on a stage and records the action.
 *
 * ⚠️  DOES NOT touch job_status — the calling controller is responsible
 *     for any status change it needs.
 */
jobSchema.methods.closeSession = function ({ stageName, action, notes = "" }) {
  const now        = new Date();
  const stageEntry = this.getActiveStage(stageName);

  if (!stageEntry) {
    throw new Error(
      `No active stage "${stageName}" found on job ${this.job_no}. ` +
        `Active stages: ${
          this.workflow_stages
            .filter(
              (s) =>
                s.action !== "completed" &&
                s.action !== "rejected" &&
                s.action !== "cancelled",
            )
            .map((s) => s.stage)
            .join(", ") || "none"
        }`,
    );
  }

  // Close the open session if one exists
  const openSess = [...stageEntry.work_sessions]
    .reverse()
    .find((s) => s.session_start && !s.session_end);

  if (openSess) {
    openSess.session_end = now;
    if (notes) openSess.notes = notes;
  }

  // Record the stage outcome action
  stageEntry.action = action;
  if (notes) stageEntry.notes = notes;

  // Stamp completed_at for terminal actions
  if (["completed", "rejected", "failed", "passed"].includes(action)) {
    stageEntry.completed_at = now;
  }

  // ✅ NO job_status change here — controller decides
};

jobSchema.methods.hasOpenSession = function (stageName) {
  const stageEntry = this.getActiveStage(stageName);
  if (!stageEntry) return false;
  return stageEntry.work_sessions.some((s) => s.session_start && !s.session_end);
};

jobSchema.methods.getSessionSummary = function (stageName) {
  const stageEntry = this.workflow_stages.find((s) => s.stage === stageName);
  if (!stageEntry) return null;

  return {
    stage:                  stageEntry.stage,
    action:                 stageEntry.action,
    total_sessions:         stageEntry.work_sessions.length,
    closed_sessions:        stageEntry.work_sessions.filter((s) => s.session_end).length,
    open_session:           stageEntry.work_sessions.some((s) => !s.session_end),
    total_duration_seconds: stageEntry.total_duration_seconds,
    total_duration_display: stageEntry.total_duration_display,
    worked_days:            stageEntry.worked_days,
    daily_summary:          stageEntry.daily_summary,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// Static Methods
// ════════════════════════════════════════════════════════════════════════════

jobSchema.statics.getWorkflowHistory = function (jobId) {
  return this.findById(jobId)
    .select(
      "job_no job_status current_stage workflow_stages " +
        "design_file design_status design_duration_seconds design_duration_display " +
        "qc_images qc_status qc_notes qc_duration_display",
    )
    .populate("workflow_stages.handled_by.user_id", "name role email")
    .populate("workflow_stages.assigned_by.user_id",  "name role")
    .lean();
};

module.exports = mongoose.models.job || mongoose.model("job", jobSchema);