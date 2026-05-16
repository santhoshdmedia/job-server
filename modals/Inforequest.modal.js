const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * InfoRequest — tracks a designer's request to view customer PII for a job.
 *
 * Lifecycle:
 *   pending  →  approved  (admin grants access)
 *            →  rejected  (admin denies)
 *
 * Access expires after `expires_at` even if approved, so designers cannot
 * retain PII indefinitely.
 */
const infoRequestSchema = new Schema(
  {
    job_id: {
      type: Schema.Types.ObjectId,
      ref: "job",
      required: true,
      index: true,
    },
    job_no: { type: String, default: "" },

    // Who is requesting
    requested_by: {
      user_id: {
        type: Schema.Types.ObjectId,
        ref: "admin_users",
        required: true,
      },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },
    request_reason: { type: String, default: "" }, // optional free-text reason

    // Status
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // Who acted on it
    reviewed_by: {
      user_id: {
        type: Schema.Types.ObjectId,
        ref: "admin_users",
        default: null,
      },
      name: { type: String, default: "" },
    },
    reviewed_at: { type: Date, default: null },
    review_notes: { type: String, default: "" },

    // Access window — approved access expires after this
    expires_at: { type: Date, default: null },
  },
  { collection: "info_requests", timestamps: true }
);

// Compound index: one pending/approved request per designer per job at a time
infoRequestSchema.index(
  { job_id: 1, "requested_by.user_id": 1, status: 1 },
  { name: "unique_active_request" }
);

module.exports =
  mongoose.models.info_requests ||
  mongoose.model("info_requests", infoRequestSchema);