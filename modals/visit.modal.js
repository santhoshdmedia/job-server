const mongoose = require("mongoose");

// ── Measurement sub-schema ──────────────────────────────────────────────────
const MeasurementSchema = new mongoose.Schema({
  label:     { type: String, default: "" },
  width:     { type: String, default: "" },
  height:    { type: String, default: "" },
  unit:      { type: String, enum: ["ft", "inch", "cm", "m"], default: "ft" },
  sq_ft:     { type: Number, default: 0 },
  notes:     { type: String, default: "" },
}, { _id: true });

// ── Photo sub-schema ────────────────────────────────────────────────────────
const PhotoSchema = new mongoose.Schema({
  url:      { type: String, required: true },
  caption:  { type: String, default: "" },
  gps: {
    lat:      Number,
    lng:      Number,
    accuracy: Number,
  },
  taken_at: { type: Date, default: Date.now },
}, { _id: true });

// ── Member sub-schema ───────────────────────────────────────────────────────
const MemberSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: "admin_users", required: true },
  name:          { type: String, required: true },
  email:         { type: String, default: "" },
  phone:         { type: String, default: "" },
  role:          { type: String, default: "Field Staff" },
  invited_at:    { type: Date, default: Date.now },
  invite_status: { type: String, enum: ["invited", "accepted", "declined"], default: "invited" },
}, { _id: true });

// ── Session log sub-schema ──────────────────────────────────────────────────
const SessionLogSchema = new mongoose.Schema({
  action:           { type: String, enum: ["started", "paused", "resumed", "completed"], required: true },
  by_user_id:       { type: mongoose.Schema.Types.ObjectId, ref: "admin_users" },
  by_name:          { type: String },
  notes:            { type: String, default: "" },
  timestamp:        { type: Date, default: Date.now },
  duration_seconds: { type: Number, default: 0 },
}, { _id: true });

// ── Main SiteVisit schema ───────────────────────────────────────────────────
const SiteVisitSchema = new mongoose.Schema({
  visit_no: { type: String, unique: true },

  // Customer
  customer_name:  { type: String, required: true, trim: true },
  customer_phone: { type: String, required: true, trim: true },
  company_name:   { type: String, default: "" },

  // Site address
  address_line1: { type: String, required: true },
  address_line2: { type: String, default: "" },
  city:          { type: String, default: "" },
  state:         { type: String, default: "" },
  pincode:       { type: String, default: "" },
  country:       { type: String, default: "India" },

  // Visit metadata
  site_type:               { type: String, default: "" },
  visit_purpose:           { type: String, default: "" },
  visit_date:              { type: Date, default: Date.now },
  estimated_delivery_date: { type: Date },
  notes:                   { type: String, default: "" },

  // People
  created_by_id:   { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
  created_by_name: { type: String, required: true },
  assigned_to: {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    name:    { type: String, default: "" },
  },
  team_members: [MemberSchema],

  // Sheet data
  measurements:   [MeasurementSchema],
  photos:         [PhotoSchema],
  observations:   { type: String, default: "" },
  recommendation: { type: String, default: "" },

  // Session / timer
  status: {
    type:    String,
    enum:    ["scheduled", "in_progress", "on_hold", "completed", "converted", "cancelled"],
    default: "scheduled",
  },
  session_logs:           [SessionLogSchema],
  total_duration_seconds: { type: Number, default: 0 },
  current_session_start:  { type: Date, default: null },

  // Conversion
  converted_to_job: { type: Boolean, default: false },
  job_id:           { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: null },
}, {
  timestamps: true,
});

// ── Auto-generate visit_no before save ────────────────────────────────────
// ✅ FIX: Do NOT use async + next together — Mongoose async pre-hooks must
//         either use async with no `next` param (return a promise) OR use
//         the callback form (next) without async.  Mixing both causes
//         "next is not a function".
SiteVisitSchema.pre("save", async function () {
  if (this.visit_no) return;                          // already set, skip

  const date   = new Date();
  const prefix = `SV-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;

  // Use this.constructor so the model reference is always correct
  const count  = await this.constructor.countDocuments({ visit_no: new RegExp(`^${prefix}`) });
  this.visit_no = `${prefix}-${String(count + 1).padStart(3, "0")}`;
});

// ── Virtuals ───────────────────────────────────────────────────────────────
SiteVisitSchema.virtual("is_live").get(function () {
  return !!this.current_session_start;
});

SiteVisitSchema.virtual("live_duration_seconds").get(function () {
  if (!this.current_session_start) return this.total_duration_seconds;
  const elapsed = Math.floor((Date.now() - new Date(this.current_session_start).getTime()) / 1000);
  return this.total_duration_seconds + Math.max(0, elapsed);
});

SiteVisitSchema.set("toJSON",   { virtuals: true });
SiteVisitSchema.set("toObject", { virtuals: true });

SiteVisitSchema.index({ "assigned_to.user_id": 1 });
SiteVisitSchema.index({ created_by_id: 1 });
SiteVisitSchema.index({ status: 1 });
SiteVisitSchema.index({ visit_date: -1 });

module.exports = mongoose.model("SiteVisit", SiteVisitSchema);