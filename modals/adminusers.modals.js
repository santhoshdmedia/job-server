const { Schema, model } = require("mongoose");

const pagePermissionSchema = new Schema({
  pageName: {
    type: String,
    required: true,
  },
  canView: {
    type: Boolean,
    default: false,
  },
  canEdit: {
    type: Boolean,
    default: false,
  },
  canDelete: {
    type: Boolean,
    default: false,
  },
}, { _id: false });

module.exports = model(
  "admin_users",
  Schema(
    {
      profileImg: {
        type: String,
      },
      name: {
        type: String,
        required: true,
      },
      email: {
        type: String,
        required: true,
        unique: true,
      },
      phone: {
        type: Number,
        required: true,
      },
      password: {
        type: String,
        required: true,
      },
      role: {
        type: String,
        enum: [
          "super admin",
          "accounting team",
          "designing team",
          "quality check",
          "production team",
          "packing team",
          "delivery team",
          "admin",
          "designing head",
          "store manager"
        ],
        required: true,
      },
      pagePermissions: [pagePermissionSchema],
      actionPermissions: {
        type: [String],
        default: [],
      },
      available: {
        type: Boolean,
        default: true,
      },
      isOnline: {
        type: Boolean,
        default: false,
      },
      is_Special:{
        type:Boolean,
        default:false
      },
      // ── Staff category ──────────────────────────────────────────────────
      // "office"    -> normal in-time/out-time attendance only.
      // "marketing" -> additionally gets the "Field Work" flow: they can
      // step out with an estimated-hours ETA; if they overrun it their
      // session freezes until a super admin resumes it (or they close it
      // themselves early if they finish on time).
      staff_category: {
        type: String,
        enum: ["office", "marketing"],
        default: "office",
      },
      // Set when a marketing staff's field-work ETA elapses: they're auto
      // logged out of attendance and CANNOT do In Time again until a super
      // admin resumes or closes it. See Staffmonitor.controller.js.
      attendance_blocked: { type: Boolean, default: false },
      attendance_blocked_reason: { type: String, default: "" },
      attendance_blocked_session_id: {
        type: Schema.Types.ObjectId,
        ref: "staff_session",
        default: null,
      },

      // ── Pay & hours settings (used by the attendance Excel export) ────────
      // The "actual"/expected working hours for this staff member per day.
      // Used to work out daily extra (overtime) vs shortfall hours.
      standard_hours_per_day: { type: Number, default: 10, min: 0 },
      // Fixed monthly salary — entered manually by a super admin per staff.
      // 0/unset means "not configured" — the export will show "—" for
      // payable salary instead of a figure.
      monthly_salary: { type: Number, default: 0, min: 0 },
    },
    {
      collection: "admin users",
      timestamps: true,
    }
  )
);