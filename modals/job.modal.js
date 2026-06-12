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
// Each cart item has an array of these — one per uploaded file.
// label  : e.g. "Cutting File", "Printing File", "Mockup", "Reference", etc.
// caption: free-text note the designer can add.
// ─────────────────────────────────────────────────────────────────────────────
const itemDesignFileSchema = new Schema(
  {
    url:       { type: String, required: true },
    file_name: { type: String, default: "" },
    file_type: { type: String, default: "" }, // JPEG | PNG | PDF | CDR | DXF …
    label:     {
      type: String,
      enum: ["Cutting File", "Printing File", "Mockup", "Reference", "Final Artwork", "Other"],
      default: "Other",
    },
    caption:     { type: String, default: "" },
    uploaded_at: { type: Date, default: () => new Date() },
    uploaded_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },
  },
  { _id: true, timestamps: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-Schema: Per-Item Designer Assignment
// A single cart item can be assigned to multiple designers.
// This tracks who is responsible for which item, their individual upload
// status, and approval state.
// ─────────────────────────────────────────────────────────────────────────────
const itemDesignerAssignmentSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    name:    { type: String, default: "" },
    role:    { type: String, default: "" },

    assigned_at:  { type: Date, default: () => new Date() },
    assigned_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    // "assigned" | "in_progress" | "uploaded" | "approved" | "rejected"
    status:           { type: String, default: "assigned" },
    status_updated_at: { type: Date, default: null },
    notes:            { type: String, default: "" },
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
// Cart Item Sub-Schema
// ─────────────────────────────────────────────────────────────────────────────
const jobCartItemSchema = new Schema(
  {
    // ── A stable client-side key so the frontend can always reference the item
    item_id: { type: String, default: "" },

    product_id:    { type: String,  default: "" },
    product_name:  { type: String },
    printing_type: { type: String },
    variation:     { type: String },
    quantity:      { type: Number,  min: 1 },
    quantity_type: { type: String,  default: "pcs" },
    price:         { type: Number,  min: 0 },

    sq_ft:        { type: Number,  default: 0 },
    sq_ft_manual: { type: Boolean, default: false },

    width:     { type: String, default: "" },
    height:    { type: String, default: "" },
    size_unit: { type: String, default: "" },
    size:      { type: String, default: "" },

    gst_percentage: { type: Number, default: 0 },
    gst_amount:     { type: Number, default: 0 },
    line_base:      { type: Number, default: 0 },
    line_total:     { type: Number, default: 0 },

    // ── Legacy single design file (kept for backward compat) ──────────────
    design_file: { type: String, default: "" },

    notes: { type: String, default: "" },

    // ── Material Issue fields ─────────────────────────────────────────────
    outsource_type:   { type: String, default: "none" },
    outsource_vendor: { type: String, default: "" },

    material_issue_id: {
      type: Schema.Types.ObjectId,
      ref:  "MaterialIssue",
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

    // ── NEW: Per-item design files (array, each with label + caption) ─────
    design_files: { type: [itemDesignFileSchema], default: [] },

    // ── NEW: Per-item design workflow status ──────────────────────────────
    // "pending" | "uploaded" | "approved" | "rejected"
    design_status: { type: String, default: "pending" },
    design_rejection_reason: { type: String, default: "" },
    design_approved_at: { type: Date, default: null },
    design_approved_by: {
      user_id: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      name:    { type: String, default: "" },
    },

    // ── NEW: Per-item designer assignments (supports multiple designers) ──
    designers: { type: [itemDesignerAssignmentSchema], default: [] },
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

    job_status:        { type: String, default: "draft" },
    status_updated_at: { type: Date },

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
    // "pending" | "partial" | "uploaded" | "approved" | "rejected"
    design_status:           { type: String,  default: "pending" },
    design_rejection_reason: { type: String,  default: "" },
    design_approved_at:      { type: Date },
    design_approved_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    design_is_sample:        { type: Boolean, default: false },

    // ── Production ─────────────────────────────────────────────────────────
    productionimg:          { type: String, default: "" },
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
    payment_mode:         { type: String,  default: "" },
    payment_amount:       { type: Number,  default: 0 },
    balance_amount:       { type: Number,  default: 0 },
    design_charges:       { type: Number,  default: 0 },
    valid_until:          { type: Date,    required: true },
    notes:                { type: String,  default: "" },
    terms_and_conditions: { type: String,  default: "" },

    converted_to_order: { type: Boolean, default: false },
    converted_at:       { type: Date },

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
  const items = this.cart_items || [];
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
  // else leave as-is (pending / uploaded set by uploadDesign for legacy)
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
    name:          user.name   || "",
    role:          user.role   || "",
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

/**
 * Find a cart item by its item_id string.
 * Falls back to Mongoose subdoc _id if item_id is not set.
 */
jobSchema.methods.findCartItem = function (itemId) {
  return (
    this.cart_items.find(i => i.item_id === itemId) ||
    this.cart_items.id(itemId) ||
    null
  );
};

/**
 * Add one or more design files to a cart item.
 * files: [{ url, file_name, file_type, label, caption, uploaded_by }]
 */
jobSchema.methods.addItemDesignFiles = function (itemId, files, uploadedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const now = new Date();
  for (const f of files) {
    item.design_files.push({
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
    });
  }

  // Promote item design_status to "uploaded" if it was pending
  if (item.design_status === "pending" || item.design_status === "rejected") {
    item.design_status = "uploaded";
  }

  return item;
};

/**
 * Remove a single design file from a cart item by file _id.
 */
jobSchema.methods.removeItemDesignFile = function (itemId, fileId) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const before = item.design_files.length;
  item.design_files = item.design_files.filter(f => f._id.toString() !== fileId.toString());

  if (item.design_files.length === before) {
    throw new Error(`Design file "${fileId}" not found on item "${itemId}".`);
  }

  // If no files remain, revert status to pending
  if (!item.design_files.length && item.design_status === "uploaded") {
    item.design_status = "pending";
  }
  return item;
};

/**
 * Approve a cart item's design.
 */
jobSchema.methods.approveItemDesign = function (itemId, approvedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  item.design_status    = "approved";
  item.design_approved_at = new Date();
  item.design_approved_by = {
    user_id: approvedBy.user_id || null,
    name:    approvedBy.name    || "",
  };
  item.design_rejection_reason = "";
  return item;
};

/**
 * Reject a cart item's design with a reason.
 */
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

/**
 * Assign one or more designers to a specific cart item.
 * designers: [{ user_id, name, role }]
 * assignedBy: { user_id, name }
 */
jobSchema.methods.assignItemDesigners = function (itemId, designers = [], assignedBy = {}) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const now = new Date();
  for (const d of designers) {
    // Prevent duplicate assignments for the same user
    const already = item.designers.some(
      ex => ex.user_id?.toString() === d.user_id?.toString()
    );
    if (already) continue;

    item.designers.push({
      user_id:    d.user_id,
      name:       d.name   || "",
      role:       d.role   || "designing team",
      assigned_at: now,
      assigned_by: {
        user_id: assignedBy.user_id || null,
        name:    assignedBy.name    || "",
      },
      status: "assigned",
    });
  }
  return item;
};

/**
 * Remove a designer from a cart item.
 */
jobSchema.methods.removeItemDesigner = function (itemId, designerUserId) {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  item.designers = item.designers.filter(
    d => d.user_id?.toString() !== designerUserId.toString()
  );
  return item;
};

/**
 * Update a designer's status on a specific item.
 * status: "in_progress" | "uploaded" | "approved" | "rejected"
 */
jobSchema.methods.updateItemDesignerStatus = function (itemId, designerUserId, status, notes = "") {
  const item = this.findCartItem(itemId);
  if (!item) throw new Error(`Cart item "${itemId}" not found.`);

  const assignment = item.designers.find(
    d => d.user_id?.toString() === designerUserId.toString()
  );
  if (!assignment) throw new Error(`Designer not assigned to item "${itemId}".`);

  assignment.status           = status;
  assignment.status_updated_at = new Date();
  if (notes) assignment.notes = notes;
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
      "qc_images qc_status qc_notes qc_duration_display cart_items",
    )
    .populate("workflow_stages.handled_by.user_id", "name role email")
    .populate("workflow_stages.assigned_by.user_id", "name role")
    .lean();
};

// Clear cache so updated schema is always used after changes
delete mongoose.models.job;
module.exports = mongoose.model("job", jobSchema);