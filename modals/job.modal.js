const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────
const secsToDisplay = (totalSeconds) => {
  const s   = Math.max(0, Math.floor(totalSeconds));
  const h   = String(Math.floor(s / 3600)).padStart(2, "0");
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
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

// ─── Recompute totals + daily_summary from closed sessions ───────────────────
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
// Sub-Schema: Per-Item Design File
// ─────────────────────────────────────────────────────────────────────────────
const itemDesignFileSchema = new Schema(
  {
    url:       { type: String, required: true },
    file_name: { type: String, default: "" },
    file_type: { type: String, default: "" },
    label: {
      type:    String,
      enum:    ["Cutting File", "Printing File", "Mockup", "Reference", "Final Artwork", "Other"],
      default: "Other",
    },
    caption:     { type: String, default: "" },
    uploaded_at: { type: Date, default: () => new Date() },
    uploaded_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    // ── per‑file assignment ──────────────────────────────
    assigned_to: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    work_status: {
      type:    String,
      default: "pending",
    },
    work_notes:      { type: String, default: "" },
    approved_at:     { type: Date, default: null },
    rejection_reason: { type: String, default: "" },
    material_issue_id: {
      type:    Schema.Types.ObjectId,
      ref:     "MaterialIssue",
      default: null,
    },
  },
  { _id: true, timestamps: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Per-Item Designer Assignment
// ─────────────────────────────────────────────────────────────────────────────
const itemDesignerAssignmentSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    name:    { type: String, default: "" },
    role:    { type: String, default: "" },

    assigned_at: { type: Date, default: () => new Date() },
    assigned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    // "assigned" | "in_progress" | "uploaded" | "approved" | "rejected"
    status:            { type: String, default: "assigned" },
    status_updated_at: { type: Date, default: null },
    notes:             { type: String, default: "" },
  },
  { _id: true, timestamps: false },
);

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

// ─────────────────────────────────────────────────────────────────────────────
// Payment Sub-Schema
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: this used to be a single embedded object (`payment`). It is now an
// ARRAY (`payments`) so every payment collected against a job is recorded as
// its own history entry instead of being overwritten. `payment_amount`,
// `balance_amount` and `next_due_date` on the parent Job document remain as
// cached/denormalized fields for fast list/table rendering, but they are
// always derived from this array via `recomputePayments()` — never set
// directly from the client.
const paymentSchema = new Schema(
  {
    amount:        { type: Number, required: true, min: 0.01 },
    method:        { type: String, default: "" },
    paid_at:       { type: Date, default: () => new Date() },
    notes:         { type: String, default: "" },
    next_due_date: { type: Date, default: null },
    // Balance remaining on the job immediately after this payment was applied.
    balance_after: { type: Number, default: 0 },

    collected_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },
  },
  { _id: true, timestamps: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Cart Item Sub-Schema
// ─────────────────────────────────────────────────────────────────────────────
const jobCartItemSchema = new Schema(
  {
    // ── Stable client-side key ────────────────────────────────────────────
    item_id: { type: String, default: "" },

    // ── Category discriminator ────────────────────────────────────────────
    // "product" | "service_office" | "service_labour"
    item_category: { type: String, default: "product" },

    // ── Common fields ─────────────────────────────────────────────────────
    product_id:    { type: String, default: "" },
    product_name:  { type: String },
    printing_type: { type: String },
    variation:     { type: String },
    quantity:      { type: Number, min: 0 },
    quantity_type: { type: String, default: "pcs" },
    price:         { type: Number, min: 0 },

    gst_percentage: { type: Number, default: 0 },
    gst_amount:     { type: Number, default: 0 },
    line_base:      { type: Number, default: 0 },
    line_total:     { type: Number, default: 0 },

    notes: { type: String, default: "" },

    // ── Product-specific ──────────────────────────────────────────────────
    sq_ft:        { type: Number, default: 0 },
    sq_ft_manual: { type: Boolean, default: false },
    width:        { type: String, default: "" },
    height:       { type: String, default: "" },
    size_unit:    { type: String, default: "" },
    size:         { type: String, default: "" },

    // Legacy single design file (kept for backward compat)
    design_file: { type: String, default: "" },

    // ── Office Work Service fields ────────────────────────────────────────
    office_type:  { type: String, default: "" },
    days:         { type: Number, default: 0 },
    hours:        { type: Number, default: 0 },
    reels_count:  { type: Number, default: 0 },
    post_count:   { type: Number, default: 0 },

    // ── Labour Work fields ────────────────────────────────────────────────
    price_per_sqft: { type: Number, default: 0 },
    price_per_hour: { type: Number, default: 0 },

    // ── Material Issue fields ─────────────────────────────────────────────
    outsource_type:   { type: String, default: "none" },
    outsource_vendor: { type: String, default: "" },

    material_issue_id: {
      type:    Schema.Types.ObjectId,
      ref:     "MaterialIssue",
      default: null,
    },

    issued_qty: { type: Number, default: 0 },

    issued_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    issued_to: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Per-item design files (array, each with label + caption) ──────────
    design_files: { type: [itemDesignFileSchema], default: [] },

    // ── Per-item design workflow ──────────────────────────────────────────
    design_status:           { type: String, default: "pending" },
    design_rejection_reason: { type: String, default: "" },
    design_approved_at:      { type: Date,   default: null },
    design_approved_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    // ── Per-item designer assignments (supports multiple) ─────────────────
    designers: { type: [itemDesignerAssignmentSchema], default: [] },

    // ── File / Production Type & Custom other flow ────────────────────────
    production_type:    { type: String, default: "" }, // "Print File" | "Cutting File" | "Print & Cut" | "Trimcap" | "Engraving" | "Other"
    other_process_type: { type: String, default: "" },
  },
  { _id: true },
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Job Schema
// ─────────────────────────────────────────────────────────────────────────────
const jobSchema = new Schema(
  {
    order_no: { type: String, default: "", index: true },
    job_no:   { type: String, unique: true, index: true },

    // ── Customer Info ──────────────────────────────────────────────────────
    customer_name:  { type: String, default: "" },
    customer_phone: { type: String, default: "" },
    company_name:   { type: String, default: "" },

    cart_items:              { type: [jobCartItemSchema] },
    delivery_address:        { type: addressSchema },
    estimated_delivery_date: { type: Date },
    order_date:              { type: Date },

    job_status:        { type: String, default: "pending_approval" },
    status_updated_at: { type: Date },

    // ── Job Approval & Material Requirement Flags ─────────────────────────
    job_approval_status: {
      type:    String,
      enum:    ["pending", "approved", "rejected"],
      default: "pending",
      index:   true,
    },
    material_needed: { type: Boolean, default: true },

    // ── Automatic Assignee References ─────────────────────────────────────
    qc_assignee: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    delivery_mode_set_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },

    // ── Live snapshot ──────────────────────────────────────────────────────
    current_stage: {
      stage:        { type: String, default: null },
      stage_label:  { type: String, default: "" },
      stage_action: { type: String, default: "assigned" },
      assigned_to: {
        user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
        name:    { type: String, default: "" },
        role:    { type: String, default: "" },
      },
      since:                  { type: Date,   default: null },
      total_duration_seconds: { type: Number, default: 0 },
      total_duration_display: { type: String, default: "00:00:00" },
      worked_days:            { type: Number, default: 0 },
    },

    // ── Full stage pipeline ────────────────────────────────────────────────
    workflow_stages: { type: [workflowStageSchema], default: [] },

    // ── Job-level design fields (legacy + summary) ────────────────────────
    design_file:             { type: String,  default: "" },
    design_drive_link:       { type: String,  default: "" },
    design_uploaded_at:      { type: Date },
    design_uploaded_by:      { type: String,  default: "" },
    design_duration_seconds: { type: Number,  default: 0 },
    design_duration_display: { type: String,  default: "00:00:00" },
    design_status:           { type: String,  default: "pending" },
    design_rejection_reason: { type: String,  default: "" },
    design_approved_at:      { type: Date },
    design_approved_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    design_is_sample:        { type: Boolean, default: false },

    // ── Production ─────────────────────────────────────────────────────────
    productionimg:          { type: [String], default: "" },
    production_status:      { type: String, default: "pending" },
    production_approved_at: { type: Date },
    production_approved_by: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },

    // ── Quality Check ──────────────────────────────────────────────────────
    qcimg:               { type: String,   default: "" },
    qc_images:           { type: [String], default: [] },
    qc_notes:            { type: String,   default: "" },
    qc_status:           { type: String,   default: "pending" },
    qc_rejection_reason: { type: String,   default: "" },
    qc_inspected_by:     { type: String,   default: "" },
    qc_inspected_at:     { type: Date },
    qc_duration_seconds: { type: Number,   default: 0 },
    qc_duration_display: { type: String,   default: "00:00:00" },
    qc_approved_at:      { type: Date },
    qc_approved_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },

    // ── Financials ─────────────────────────────────────────────────────────
    subtotal:             { type: Number,  default: 0 },
    discount_percentage:  { type: Number,  default: 0, min: 0, max: 100 },
    discount_amount:      { type: Number,  default: 0 },
    taxable_amount:       { type: Number,  default: 0 },
    tax_amount:           { type: Number,  default: 0 },
    delivery_charges:     { type: Number,  default: 0 },
    free_delivery:        { type: Boolean, default: false },
    total_amount:         { type: Number,  required: true },
    gst_no:               { type: String,  default: "" },

    // ── Payments ───────────────────────────────────────────────────────────
    // Full history of payments collected against this job. Use
    // `job.addPayment({...})` to push a new entry — never push directly,
    // so cached totals stay in sync.
    payments:        { type: [paymentSchema], default: [] },
    // Cached/denormalized — always derived from `payments` via recomputePayments().
    payment_amount:  { type: Number,  default: 0 },
    balance_amount:  { type: Number,  default: 0 },
    next_due_date:   { type: Date,    default: null },

    design_charges:       { type: Number,  default: 0 },
    valid_until:          { type: Date,    required: true },
    notes:                { type: String,  default: "" },
    terms_and_conditions: { type: String,  default: "" },

    converted_to_order: { type: Boolean, default: false },
    converted_at:       { type: Date },

    // ── Delivery & Payment Mode Workflow ───────────────────────────────────
    delivery_mode:         { type: String, default: "" },
    delivery_payment_mode: { type: String, default: "" },
    is_credit:             { type: Boolean, default: false },
    credit_details: {
      approved_by: {
        user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
        name:    { type: String, default: "" },
        role:    { type: String, default: "" },
      },
      approved_at:   { type: Date, default: null },
      credit_amount: { type: Number, default: 0 },
      due_date:      { type: Date, default: null },
      notes:         { type: String, default: "" },
    },
    delivery_assigned_to: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
      role:    { type: String, default: "" },
    },
    delivery_notes:   { type: String, default: "" },
    delivery_status:  { type: String, default: "pending" },
    receiver_name:    { type: String, default: "" },
    tracking_no:      { type: String, default: "" },
    delivery_photos:  { type: [String], default: [] },

    // ── Final Dedicated Completion Snapshot ────────────────────────────────
    final_delivery: {
      status:          { type: String, default: "pending" },
      delivery_method: { type: String, default: "" },
      tracking_no:     { type: String, default: "" },
      courier_name:    { type: String, default: "" },
      receiver_name:   { type: String, default: "" },
      receiver_phone:  { type: String, default: "" },
      delivery_date:   { type: Date,   default: null },
      delivery_notes:  { type: String, default: "" },
      payment_status:  { type: String, default: "" },
      credit_amount:   { type: Number, default: 0 },
      delivered_by: {
        user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
        name:    { type: String, default: "" },
      },
      photos:       { type: [String], default: [] },
      completed_at: { type: Date,     default: null },
    },

    // ── Soft delete ────────────────────────────────────────────────────────
    deletedAt:     { type: Date,   default: null },
    deleted_notes: { type: String, default: "" },
    deleted_by:    { type: Schema.Types.ObjectId, ref: "admin_users", default: null },

    created_by:  { type: String, default: "admin" },
    approved_by: { type: String, default: "admin" },

    created_by_admin_id: {
      type: Schema.Types.ObjectId, ref: "admin_users", default: null, index: true,
    },
    approved_by_admin_id: {
      type: Schema.Types.ObjectId, ref: "admin_users", default: null, index: true,
    },

    // ── ✅ Site Visit back-reference ───────────────────────────────────────
    site_visit_id: {
      type:    Schema.Types.ObjectId,
      ref:     "SiteVisit",
      default: null,
      index:   true,
    },
    site_visit_photos: {
      type: [Object],
      default: [],
    },
    site_visit_no: {
      type:    String,
      default: "",
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

// Auto-generate item_id for any cart item that lacks one
jobSchema.pre("save", function () {
  for (const item of this.cart_items || []) {
    if (!item.item_id) {
      item.item_id = new mongoose.Types.ObjectId().toHexString();
    }
  }
});

// Recompute workflow totals + sync current_stage snapshot
jobSchema.pre("save", function () {
  if (!this.isModified("workflow_stages")) return;

  for (const stageEntry of this.workflow_stages) {
    stageEntry.recomputeTotals();
  }

  if (this.isModified("current_stage")) return;
  if (!this.workflow_stages.length) return;

  const active =
    [...this.workflow_stages]
      .reverse()
      .find(s => s.action !== "completed" && s.action !== "rejected" && s.action !== "cancelled")
    || this.workflow_stages[this.workflow_stages.length - 1];

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

// Sync job-level design_status from item statuses
jobSchema.pre("save", function () {
  const items = (this.cart_items || []).filter(
    i => i.item_category === "product" || i.item_category === "service_office" || !i.item_category,
  );
  if (!items.length) return;

  const total    = items.length;
  const approved = items.filter(i => i.design_status === "approved").length;
  const uploaded = items.filter(i => ["uploaded", "approved"].includes(i.design_status)).length;
  const rejected = items.filter(i => i.design_status === "rejected").length;

  if (approved === total) {
    this.design_status = "approved";
    if (!this.design_approved_at) this.design_approved_at = new Date();
  } else if (rejected > 0) {
    this.design_status = "rejected";
  } else if (uploaded > 0) {
    this.design_status = "partial";
  }
});

// Recompute payment_amount / balance_amount / next_due_date whenever the
// payments array changes, OR whenever total_amount changes (e.g. job items
// were edited) so the balance always reflects reality.
jobSchema.pre("save", function () {
  if (this.isModified("payments") || this.isModified("total_amount")) {
    this.recomputePayments();
  }
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
// Instance Methods — Payments
// ════════════════════════════════════════════════════════════════════════════

/**
 * Recalculate payment_amount / balance_amount / next_due_date from the
 * `payments` array against the current `total_amount`. This is the single
 * source of truth — call it (or just save after modifying `payments` /
 * `total_amount`, since the pre-save hook calls it automatically) instead of
 * setting those cached fields by hand.
 */
jobSchema.methods.recomputePayments = function () {
  const totalPaid = (this.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const total     = parseFloat(this.total_amount) || 0;
  const balance   = parseFloat((total - totalPaid).toFixed(2));

  this.payment_amount = parseFloat(totalPaid.toFixed(2));
  this.balance_amount = balance;

  if (balance <= 0) {
    // Fully paid (or overpaid/advance) — nothing left to chase.
    this.next_due_date = null;
  } else if (this.payments && this.payments.length) {
    // Use whatever due date was set on the most recent payment.
    const last = this.payments[this.payments.length - 1];
    this.next_due_date = last.next_due_date || null;
  }
};

/**
 * Record a new payment against this job. Validates the amount against the
 * current balance, pushes a history entry with `balance_after` snapshot, and
 * recomputes the cached totals. Caller is still responsible for calling
 * `job.save()`.
 */
jobSchema.methods.addPayment = function ({ amount, method = "", notes = "", next_due_date = null, paid_at = null, collected_by = {} }) {
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const priorPaid = (this.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const total     = parseFloat(this.total_amount) || 0;
  const priorBalance = parseFloat((total - priorPaid).toFixed(2));

  if (amt > priorBalance + 0.01) {
    throw new Error(`Payment amount (₹${amt.toFixed(2)}) exceeds the outstanding balance (₹${priorBalance.toFixed(2)}).`);
  }

  const balanceAfter = parseFloat((priorBalance - amt).toFixed(2));

  this.payments.push({
    amount:        amt,
    method,
    notes,
    paid_at:       paid_at ? new Date(paid_at) : new Date(),
    next_due_date: balanceAfter > 0 && next_due_date ? new Date(next_due_date) : null,
    balance_after: balanceAfter,
    collected_by: {
      user_id: collected_by.user_id || null,
      name:    collected_by.name    || "",
    },
  });

  this.recomputePayments();
  return this;
};

// ════════════════════════════════════════════════════════════════════════════
// Instance Methods — Session Management
// ════════════════════════════════════════════════════════════════════════════

jobSchema.methods.getActiveStage = function (stageName) {
  return (
    this.workflow_stages.find(
      s => s.stage === stageName &&
           s.action !== "completed" &&
           s.action !== "rejected" &&
           s.action !== "cancelled",
    ) || null
  );
};

jobSchema.methods.openSession = function ({ stageName, stageLabel = "", user, assignedBy = null, notes = "" }) {
  const now      = new Date();
  const workDate = now.toISOString().slice(0, 10);

  let stageEntry = this.getActiveStage(stageName);

  if (!stageEntry) {
    this.workflow_stages.push({
      stage:         stageName,
      stage_label:   stageLabel || stageName,
      handled_by:    { user_id: user.user_id, name: user.name, role: user.role || "" },
      assigned_by:   assignedBy || {},
      action:        "in_progress",
      assigned_at:   now,
      started_at:    now,
      work_sessions: [],
      notes,
    });
    stageEntry = this.workflow_stages[this.workflow_stages.length - 1];
  } else {
    stageEntry.action = "in_progress";
    if (!stageEntry.started_at) stageEntry.started_at = now;
  }

  for (const s of stageEntry.work_sessions) {
    if (s.session_start && !s.session_end) s.session_end = now;
  }

  stageEntry.work_sessions.push({
    user_id:       user.user_id || null,
    name:          user.name    || "",
    role:          user.role    || "",
    session_start: now,
    session_end:   null,
    work_date:     workDate,
    notes,
  });
};

jobSchema.methods.closeSession = function ({ stageName, action, notes = "" }) {
  const now        = new Date();
  const stageEntry = this.getActiveStage(stageName);

  if (!stageEntry) {
    throw new Error(`No active stage "${stageName}" found on job ${this.job_no}.`);
  }

  const openSess = [...stageEntry.work_sessions].reverse().find(s => s.session_start && !s.session_end);
  if (openSess) { openSess.session_end = now; if (notes) openSess.notes = notes; }

  stageEntry.action = action;
  if (notes) stageEntry.notes = notes;
  if (["completed", "rejected", "failed", "passed"].includes(action)) stageEntry.completed_at = now;
};

jobSchema.methods.hasOpenSession = function (stageName) {
  const stageEntry = this.getActiveStage(stageName);
  if (!stageEntry) return false;
  return stageEntry.work_sessions.some(s => s.session_start && !s.session_end);
};

jobSchema.methods.getSessionSummary = function (stageName) {
  const stageEntry = this.workflow_stages.find(s => s.stage === stageName);
  if (!stageEntry) return null;
  return {
    stage:                  stageEntry.stage,
    action:                 stageEntry.action,
    total_sessions:         stageEntry.work_sessions.length,
    closed_sessions:        stageEntry.work_sessions.filter(s => s.session_end).length,
    open_session:           stageEntry.work_sessions.some(s => !s.session_end),
    total_duration_seconds: stageEntry.total_duration_seconds,
    total_duration_display: stageEntry.total_duration_display,
    worked_days:            stageEntry.worked_days,
    daily_summary:          stageEntry.daily_summary,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// Instance Methods — Per-Item Design Helpers
// ════════════════════════════════════════════════════════════════════════════

jobSchema.methods.findCartItem = function (itemId) {
  return (
    this.cart_items.find(i => i.item_id === itemId) ||
    this.cart_items.id(itemId) ||
    null
  );
};

jobSchema.methods.addItemDesignFiles = function (itemId, files, uploadedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const now = new Date();
  for (const f of files) {
    const fileData = {
      url:         f.url,
      file_name:   f.file_name   || "",
      file_type:   f.file_type   || "",
      label:       f.label       || "Other",
      caption:     f.caption     || "",
      uploaded_at: now,
      uploaded_by: {
        user_id: uploadedBy.user_id || null,
        name:    uploadedBy.name    || "",
      },
    };
    if (f.assigned_to) {
      fileData.assigned_to = {
        user_id: f.assigned_to.user_id || null,
        name:    f.assigned_to.name    || "",
        role:    f.assigned_to.role    || "",
      };
    }
    if (f.work_status) fileData.work_status = f.work_status;
    if (f.work_notes)  fileData.work_notes  = f.work_notes;

    item.design_files.push(fileData);
  }

  if (item.design_status === "pending" || item.design_status === "rejected") {
    item.design_status = "uploaded";
  }

  return item;
};

jobSchema.methods.removeItemDesignFile = function (itemId, fileId) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const before = item.design_files.length;
  item.design_files = item.design_files.filter(f => f._id.toString() !== fileId.toString());

  if (item.design_files.length === before) {
    throw new Error(`Design file "${fileId}" not found on item "${itemId}".`);
  }

  if (!item.design_files.length && item.design_status === "uploaded") {
    item.design_status = "pending";
  }
  return item;
};

jobSchema.methods.approveItemDesign = function (itemId, approvedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  item.design_status           = "approved";
  item.design_approved_at      = new Date();
  item.design_approved_by      = { user_id: approvedBy.user_id || null, name: approvedBy.name || "" };
  item.design_rejection_reason = "";
  return item;
};

jobSchema.methods.rejectItemDesign = function (itemId, reason, rejectedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  item.design_status           = "rejected";
  item.design_rejection_reason = reason || "";
  item.design_approved_at      = null;
  item.design_approved_by      = {};
  return item;
};

// ════════════════════════════════════════════════════════════════════════════
// Instance Methods — Per-Item Designer Assignment Helpers
// ════════════════════════════════════════════════════════════════════════════

jobSchema.methods.assignItemDesigners = function (itemId, designers = [], assignedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const now = new Date();
  for (const d of designers) {
    const already = item.designers.some(ex => ex.user_id?.toString() === d.user_id?.toString());
    if (already) continue;

    item.designers.push({
      user_id:     d.user_id,
      name:        d.name   || "",
      role:        d.role   || "designing team",
      assigned_at: now,
      assigned_by: { user_id: assignedBy.user_id || null, name: assignedBy.name || "" },
      status:      "assigned",
    });
  }
  return item;
};

jobSchema.methods.removeItemDesigner = function (itemId, designerUserId) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  item.designers = item.designers.filter(d => d.user_id?.toString() !== designerUserId.toString());
  return item;
};

jobSchema.methods.updateItemDesignerStatus = function (itemId, designerUserId, status, notes = "") {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const assignment = item.designers.find(d => d.user_id?.toString() === designerUserId.toString());
  if (!assignment) throw new Error(`Designer not assigned to item "${itemId}".`);

  assignment.status            = status;
  assignment.status_updated_at = new Date();
  if (notes) assignment.notes  = notes;
  return item;
};

// ════════════════════════════════════════════════════════════════════════════
// Static Methods
// ════════════════════════════════════════════════════════════════════════════

jobSchema.statics.getWorkflowHistory = function (jobId) {
  return this.findById(jobId)
    .select(
      "job_no job_status current_stage workflow_stages " +
      "design_file design_status design_duration_seconds design_duration_display " +
      "qc_images qc_status qc_notes qc_duration_display cart_items " +
      "site_visit_id site_visit_no site_visit_photos",
    )
    .populate("workflow_stages.handled_by.user_id", "name role email")
    .populate("workflow_stages.assigned_by.user_id", "name role")
    .lean();
};

/**
 * Find all jobs that were converted from a specific site visit.
 * Usage: Job.findBySiteVisit("6654abc...")
 */
jobSchema.statics.findBySiteVisit = function (siteVisitId) {
  return this.find({ site_visit_id: siteVisitId }).sort({ createdAt: -1 }).lean();
};

// ════════════════════════════════════════════════════════════════════════════
// Static Helpers for Service Item Queries
// ════════════════════════════════════════════════════════════════════════════

jobSchema.statics.findByOfficeServiceType = function (officeType) {
  return this.find({ "cart_items.item_category": "service_office", "cart_items.office_type": officeType });
};

jobSchema.statics.findWithLabourWork = function () {
  return this.find({ "cart_items.item_category": "service_labour" });
};

// Clear cache so updated schema is always used after changes
delete mongoose.models.job;
module.exports = mongoose.model("job", jobSchema);