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
  },
  { collection: "staff_sessions", timestamps: false },
);

staffSessionSchema.index({ staff_id: 1, login_at: -1 });
staffSessionSchema.index({ staff_id: 1, logout_at: 1 });
staffSessionSchema.index({ date: 1, logout_at: 1 });

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