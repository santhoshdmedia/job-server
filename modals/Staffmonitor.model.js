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
    // Each element: { start, end, type: "break"|"lunch", duration_seconds }
    breaks: [
      {
        type: { type: String, enum: ["break", "lunch"], default: "break" },
        start: { type: Date, required: true },
        end:   { type: Date, default: null },
        duration_seconds: { type: Number, default: 0 },
      },
    ],

    // Active break pointer — null when not on break
    active_break: {
      type:  { type: String, enum: ["break", "lunch"], default: null },
      start: { type: Date, default: null },
    },

    // ── Overtime ─────────────────────────────────────────────────────────
    // Standard working day is 8 hours (28800 seconds).
    // OT is computed on logout: max(0, working_seconds - 28800).
    working_seconds:   { type: Number, default: 0 }, // net = session - breaks
    break_seconds:     { type: Number, default: 0 }, // total break time
    overtime_seconds:  { type: Number, default: 0 }, // computed on logout
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

module.exports = { StaffSession, StaffTaskLog };