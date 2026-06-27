const mongoose = require("mongoose");
const { Schema } = mongoose;

// ─── StaffSession ─────────────────────────────────────────────────────────────
// Tracks every login/logout event for an admin_users document.
//
// FIELDS:
//   staff_id          — ref to admin_users
//   login_at          — when the session started (required)
//   logout_at         — when the session ended (null = still active)
//   duration_seconds  — computed on logout: logout_at - login_at
//   date              — "YYYY-MM-DD" of the login_at (for date-based queries)
//   login_ip          — optional: client IP at login time
//   selfie_url        — URL of the selfie photo captured at login (optional)
//   location          — lat/lng/accuracy captured at login (optional)

const staffSessionSchema = new Schema(
  {
    staff_id: {
      type:     Schema.Types.ObjectId,
      ref:      "admin_users",
      required: true,
      index:    true,
    },
    login_at: {
      type:     Date,
      required: true,
      default:  () => new Date(),
    },
    logout_at: {
      type:    Date,
      default: null,
    },
    duration_seconds: {
      type:    Number,
      default: 0,
    },
    // "YYYY-MM-DD" — pre-computed for fast date-range queries
    date: {
      type:  String,
      index: true,
      default() {
        return new Date().toISOString().slice(0, 10);
      },
    },
    login_ip: {
      type:    String,
      default: "",
    },

    // ── NEW: Selfie captured at check-in ─────────────────────────────────
    selfie_url: {
      type:    String,
      default: "",
      trim:    true,
    },

    // ── NEW: GPS location at check-in ────────────────────────────────────
    location: {
      latitude: {
        type:    Number,
        default: null,
      },
      longitude: {
        type:    Number,
        default: null,
      },
      accuracy: {
        type:    Number,   // metres
        default: null,
      },
    },
  },
  {
    collection: "staff_sessions",
    timestamps: false,
  },
);

// Compound index: fast lookup of all sessions for one staff member ordered by time
staffSessionSchema.index({ staff_id: 1, login_at: -1 });
// Find open sessions (logout_at: null)
staffSessionSchema.index({ staff_id: 1, logout_at: 1 });
// Dashboard: today's sessions across all staff
staffSessionSchema.index({ date: 1, logout_at: 1 });

const StaffSession =
  mongoose.models.staff_session ||
  mongoose.model("staff_session", staffSessionSchema);


// ─── StaffTaskLog ─────────────────────────────────────────────────────────────
// One entry per hourly update a staff member submits (or admin adds on behalf).
//
// FIELDS:
//   staff_id     — who submitted
//   message      — free-text task description
//   job_ref      — optional job number / reference string
//   hour_label   — human-readable time at submission, e.g. "02:30 PM"
//   submitted_at — exact timestamp
//   submitted_by — ObjectId of whoever pushed the entry
//                  (same as staff_id for self-logs; super admin _id for admin-added logs)

const staffTaskLogSchema = new Schema(
  {
    staff_id: {
      type:     Schema.Types.ObjectId,
      ref:      "admin_users",
      required: true,
      index:    true,
    },
    message: {
      type:     String,
      required: true,
      trim:     true,
    },
    job_ref: {
      type:    String,
      default: "",
      trim:    true,
    },
    hour_label: {
      type:    String,
      default: "",
    },
    submitted_at: {
      type:    Date,
      default: () => new Date(),
      index:   true,
    },
    submitted_by: {
      type:    Schema.Types.ObjectId,
      ref:     "admin_users",
      default: null,
    },
  },
  {
    collection: "staff_task_logs",
    timestamps: false,
  },
);

staffTaskLogSchema.index({ staff_id: 1, submitted_at: -1 });
staffTaskLogSchema.index({ submitted_at: -1 });

const StaffTaskLog =
  mongoose.models.staff_task_log ||
  mongoose.model("staff_task_log", staffTaskLogSchema);

module.exports = { StaffSession, StaffTaskLog };