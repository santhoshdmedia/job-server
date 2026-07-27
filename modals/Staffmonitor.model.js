const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─── StaffSession ─────────────────────────────────────────────────────────────
const staffSessionSchema = new Schema(
  {
    staff_id: { type: Schema.Types.ObjectId, ref: "admin_users", required: true, index: true },
    login_at:  { type: Date, required: true, default: () => new Date() },
    logout_at: { type: Date, default: null },
    duration_seconds:  { type: Number, default: 0 },
    date: {
      type: String, index: true,
      default() { return new Date().toISOString().slice(0, 10); },
    },
    login_ip:   { type: String, default: "" },
    selfie_url: { type: String, default: "", trim: true },
    location: {
      latitude:          { type: Number, default: null },
      longitude:         { type: Number, default: null },
      accuracy:          { type: Number, default: null },
      formatted_address: { type: String, default: "", trim: true },
      place_name:        { type: String, default: "", trim: true },
    },

    // ── Break / Lunch tracking ────────────────────────────────────────────
    breaks: [
      {
        type: { type: String, enum: ["break", "lunch"], default: "break" },
        start: { type: Date, required: true },
        end:   { type: Date, default: null },
        duration_seconds: { type: Number, default: 0 },
      },
    ],
    active_break: {
      type:  { type: String, enum: ["break", "lunch"], default: null },
      start: { type: Date, default: null },
    },

    // ── Overtime ─────────────────────────────────────────────────────────
    working_seconds:   { type: Number, default: 0 },
    break_seconds:     { type: Number, default: 0 },
    overtime_seconds:  { type: Number, default: 0 },

    // ── Logout tracking ─────────────────────────────────────────────────
    // "manual"                  -> staff clicked logout themselves
    // "forced_admin"            -> super admin force-logged them out (e.g. they forgot to log out)
    // "auto_7pm"                -> system auto-logout at the 7 PM cutoff (no approved permission)
    // "auto_permission_expired" -> system auto-logout because their approved after-hours window ended
    logout_type: {
      type: String,
      // enum: ["manual", "forced_admin", "auto_7pm", "auto_permission_expired"],
      default: "manual",
    },
    forced_logout_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    forced_logout_by_name: { type: String, default: "" },

    // ── Field Work (marketing team: "going out" with an ETA) ───────────────
    // Only meaningful for staff with staff_category === "marketing".
    // Lifecycle:
    //   none -> active                    (staff taps "Going Out", gives estimated_hours)
    //   active -> closed                  (staff finishes on time / early -> "Back to Office")
    //   active -> frozen                  (estimated time elapsed, nothing logged yet -> auto, lazy-checked)
    //   frozen -> resume_requested         (staff asks admin to resume)
    //   frozen|resume_requested -> active  (admin resumes, optionally granting more hours)
    //   frozen|resume_requested -> closed  (admin force-closes instead of resuming)
    field_work: {
      status: {
        type: String,
        enum: ["none", "active", "frozen", "resume_requested", "closed"],
        default: "none",
      },
      reason:          { type: String, default: "", trim: true },
      estimated_hours: { type: Number, default: null },
      started_at:      { type: Date, default: null },
      expected_end_at: { type: Date, default: null },
      frozen_at:       { type: Date, default: null },

      resume_requested_at: { type: Date, default: null },
      resume_reason:        { type: String, default: "", trim: true },

      resumed_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      resumed_by_name: { type: String, default: "" },
      resumed_at:      { type: Date, default: null },

      closed_by:       { type: String, enum: ["staff", "admin", null], default: null },
      closed_by_id:    { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      closed_by_name:  { type: String, default: "" },
      closed_at:       { type: Date, default: null },

      // Audit trail — one entry per start/close/freeze/resume-request/resume.
      history: [
        {
          action:   { type: String, required: true }, // "started" | "closed_by_staff" | "frozen" | "resume_requested" | "resumed_by_admin" | "closed_by_admin"
          at:       { type: Date, default: () => new Date() },
          by_name:  { type: String, default: "" },
          notes:    { type: String, default: "" },
          estimated_hours: { type: Number, default: null },
        },
      ],
    },

    // ── After-7-PM work permission ────────────────────────────────────────
    // Staff who need to keep working past the 7 PM auto-logout cutoff must
    // request permission; a super admin approves/rejects it with an
    // explicit "permitted_until" time. The auto-logout sweep respects it.
    permission: {
      status: {
        type: String,
        enum: ["none", "pending", "approved", "rejected"],
        default: "none",
      },
      reason:           { type: String, default: "", trim: true },
      requested_at:     { type: Date, default: null },
      requested_until:  { type: Date, default: null }, // what the staff asked for
      responded_by:     { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
      responded_by_name:{ type: String, default: "" },
      responded_at:     { type: Date, default: null },
      permitted_until:  { type: Date, default: null }, // admin-approved cutoff
      response_note:    { type: String, default: "", trim: true },
    },
  },
  { collection: "staff_sessions", timestamps: false },
);

staffSessionSchema.index({ staff_id: 1, login_at: -1 });
staffSessionSchema.index({ staff_id: 1, logout_at: 1 });
staffSessionSchema.index({ date: 1, logout_at: 1 });
staffSessionSchema.index({ logout_at: 1, "permission.status": 1 });
staffSessionSchema.index({ "field_work.status": 1 });

const StaffSession =
  mongoose.models.staff_session ||
  mongoose.model("staff_session", staffSessionSchema);

// ─── StaffTaskLog ─────────────────────────────────────────────────────────────
const staffTaskLogSchema = new Schema(
  {
    staff_id:     { type: Schema.Types.ObjectId, ref: "admin_users", required: true, index: true },
    message:      { type: String, required: true, trim: true },
    job_ref:      { type: String, default: "", trim: true },
    hour_label:   { type: String, default: "" },
    submitted_at: { type: Date, default: () => new Date(), index: true },
    submitted_by: { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
  },
  { collection: "staff_task_logs", timestamps: false },
);
staffTaskLogSchema.index({ staff_id: 1, submitted_at: -1 });
staffTaskLogSchema.index({ submitted_at: -1 });

const StaffTaskLog =
  mongoose.models.staff_task_log ||
  mongoose.model("staff_task_log", staffTaskLogSchema);

// ─── StaffAssignedTask ──────────────────────────────────────────────────────
// Admin-assigned jobs, e.g. "Stock checking – 2 hours".
// Lifecycle: pending -> in_progress -> completed
//                                  \-> stopped (notes required) -> resume_requested -> in_progress (admin only)
const staffAssignedTaskSchema = new Schema(
  {
    staff_id:    { type: Schema.Types.ObjectId, ref: "admin_users", required: true, index: true },
    title:       { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    estimated_hours: { type: Number, default: 0 },
    due_at:      { type: Date, default: null },

    assigned_by:      { type: Schema.Types.ObjectId, ref: "admin_users", default: null },
    assigned_by_name: { type: String, default: "Admin" },
    assigned_at:      { type: Date, default: () => new Date() },

    status: {
      type: String,
      enum: ["pending", "in_progress", "stopped", "resume_requested", "completed"],
      default: "pending",
      index: true,
    },

    // Work sessions — each start/stop/resume pushes a new entry
    sessions: [
      {
        start: { type: Date, required: true },
        end:   { type: Date, default: null },
        duration_seconds: { type: Number, default: 0 },
      },
    ],
    total_seconds: { type: Number, default: 0 },

    // Notes captured from the "stop" popup
    stop_notes: { type: String, default: "", trim: true },
    stop_history: [
      {
        notes:      { type: String, default: "", trim: true },
        stopped_at: { type: Date, required: true },
      },
    ],
    resume_requested_at: { type: Date, default: null },

    started_at:   { type: Date, default: null },
    completed_at: { type: Date, default: null },
  },
  { collection: "staff_assigned_tasks", timestamps: false },
);
staffAssignedTaskSchema.index({ staff_id: 1, status: 1 });
staffAssignedTaskSchema.index({ status: 1, assigned_at: -1 });

const StaffAssignedTask =
  mongoose.models.staff_assigned_task ||
  mongoose.model("staff_assigned_task", staffAssignedTaskSchema);

module.exports = { StaffSession, StaffTaskLog, StaffAssignedTask };