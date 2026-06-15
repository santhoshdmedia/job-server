const mongoose  = require("mongoose");
const SiteVisit = require("../modals/visit.modal");

// ─── Helpers ───────────────────────────────────────────────────────────────
const ok  = (res, data, msg = "Success", code = 200) => res.status(code).json({ success: true,  message: msg,  data });
const err = (res, msg  = "Error",        code = 400)  => res.status(code).json({ success: false, message: msg });

// ── CREATE a new site visit ─────────────────────────────────────────────────
const createSiteVisit = async (req, res) => {
  try {
    const {
      customer_name, customer_phone, company_name,
      address_line1, address_line2, city, state, pincode, country,
      site_type, visit_purpose, visit_date, estimated_delivery_date,
      notes, assigned_to, created_by_id, created_by_name,
    } = req.body;

    if (!customer_name)  return err(res, "customer_name is required");
    if (!customer_phone) return err(res, "customer_phone is required");
    if (!address_line1)  return err(res, "address_line1 is required");
    if (!created_by_id)  return err(res, "created_by_id is required");
    if (!created_by_name) return err(res, "created_by_name is required");

    const visit = new SiteVisit({
      customer_name, customer_phone, company_name: company_name || "",
      address_line1, address_line2: address_line2 || "",
      city: city || "", state: state || "", pincode: pincode || "",
      country: country || "India",
      site_type: site_type || "", visit_purpose: visit_purpose || "",
      visit_date:  visit_date  ? new Date(visit_date)  : new Date(),
      estimated_delivery_date: estimated_delivery_date ? new Date(estimated_delivery_date) : undefined,
      notes: notes || "",
      created_by_id, created_by_name,
      assigned_to: assigned_to || {},
      status: "scheduled",
    });

    await visit.save();
    ok(res, visit, "Site visit created", 201);
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── GET ALL visits (admin) ──────────────────────────────────────────────────
const getAllSiteVisits = async (req, res) => {
  try {
    const { status, limit = 200, page = 1 } = req.query;
    const query = {};
    if (status) query.status = status;

    const visits = await SiteVisit.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean({ virtuals: true });

    const total = await SiteVisit.countDocuments(query);
    ok(res, { visits, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── GET visits assigned to a specific user ──────────────────────────────────
// Only returns visits where the user is:
//   1. The assigned field staff (assigned_to.user_id)
//   2. An invited team member (team_members.user_id)
// Does NOT include visits merely created_by this user — creators are admins
// who should use the getAllSiteVisits (admin) endpoint instead.
const getVisitsByUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // Cast to ObjectId so the $or comparison works regardless of how it was stored
    let oid;
    try {
      oid = new mongoose.Types.ObjectId(userId);
    } catch {
      return err(res, "Invalid userId", 400);
    }

    const visits = await SiteVisit.find({
      $or: [
        { "assigned_to.user_id": oid },
        { "team_members.user_id": oid },
      ],
    })
      .sort({ visit_date: -1 })
      .lean({ virtuals: true });

    ok(res, visits);
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── GET single visit ────────────────────────────────────────────────────────
const getSiteVisit = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id).lean({ virtuals: true });
    if (!visit) return err(res, "Site visit not found", 404);
    ok(res, visit);
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── UPDATE basic visit info ─────────────────────────────────────────────────
const updateSiteVisit = async (req, res) => {
  try {
    const allowed = [
      "customer_name","customer_phone","company_name",
      "address_line1","address_line2","city","state","pincode","country",
      "site_type","visit_purpose","visit_date","estimated_delivery_date",
      "notes","assigned_to","observations","recommendation","status",
    ];
    const updates = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const visit = await SiteVisit.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!visit) return err(res, "Site visit not found", 404);
    ok(res, visit, "Updated");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── DELETE visit ────────────────────────────────────────────────────────────
const deleteSiteVisit = async (req, res) => {
  try {
    await SiteVisit.findByIdAndDelete(req.params.id);
    ok(res, null, "Deleted");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

// ── START / RESUME session ──────────────────────────────────────────────────
const startSession = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);
    if (visit.current_session_start) return err(res, "Session already running");

    const { by_user_id, by_name, notes } = req.body;
    const now  = new Date();
    const action = (visit.session_logs || []).length === 0 ? "started" : "resumed";

    visit.current_session_start = now;
    visit.status = "in_progress";
    visit.session_logs.push({ action, by_user_id, by_name, notes: notes || "", timestamp: now });
    await visit.save();

    ok(res, visit.toJSON(), `Session ${action}`);
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── PAUSE / COMPLETE session ────────────────────────────────────────────────
const closeSession = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);
    if (!visit.current_session_start) return err(res, "No open session");

    const { action = "paused", by_user_id, by_name, notes } = req.body;
    const now     = new Date();
    const elapsed = Math.max(0, Math.floor((now - new Date(visit.current_session_start)) / 1000));

    visit.total_duration_seconds += elapsed;
    visit.current_session_start   = null;
    visit.status = action === "completed" ? "completed" : "on_hold";
    visit.session_logs.push({ action, by_user_id, by_name, notes: notes || "", timestamp: now, duration_seconds: elapsed });
    await visit.save();

    ok(res, visit.toJSON(), `Session ${action}`);
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── SESSION STATUS ──────────────────────────────────────────────────────────
const getSessionStatus = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id).lean({ virtuals: true });
    if (!visit) return err(res, "Not found", 404);

    const closedSessions = (visit.session_logs || []).filter((l) => ["paused","completed","resumed"].includes(l.action)).length;
    const workedDays     = [...new Set((visit.session_logs || []).map((l) => new Date(l.timestamp).toDateString()))].length;

    ok(res, {
      has_open_session:       !!visit.current_session_start,
      open_since:             visit.current_session_start || null,
      total_duration_seconds: visit.total_duration_seconds || 0,
      live_duration_seconds:  visit.live_duration_seconds  || 0,
      closed_sessions:        closedSessions,
      worked_days:            workedDays,
      status:                 visit.status,
    });
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// TEAM MEMBERS
// ════════════════════════════════════════════════════════════════════════════

// ── INVITE member ───────────────────────────────────────────────────────────
const inviteMember = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    const { user_id, name, email, phone, role } = req.body;
    if (!user_id || !name) return err(res, "user_id and name required");

    // Avoid duplicate
    const already = visit.team_members.find((m) => String(m.user_id) === String(user_id));
    if (already) return err(res, "Member already invited");

    visit.team_members.push({ user_id, name, email: email || "", phone: phone || "", role: role || "Field Staff" });
    await visit.save();
    ok(res, visit, "Member invited");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── REMOVE member ──────────────────────────────────────────────────────────
const removeMember = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    visit.team_members = visit.team_members.filter((m) => String(m._id) !== req.params.memberId);
    await visit.save();
    ok(res, visit, "Member removed");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// MEASUREMENTS
// ════════════════════════════════════════════════════════════════════════════

// ── ADD measurement ─────────────────────────────────────────────────────────
const addMeasurement = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    const { label, width, height, unit, sq_ft, notes } = req.body;
    visit.measurements.push({ label: label || "", width, height, unit: unit || "ft", sq_ft: sq_ft || 0, notes: notes || "" });
    await visit.save();
    ok(res, visit, "Measurement added");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── UPDATE all measurements (replace array) ─────────────────────────────────
const updateMeasurements = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    const { measurements } = req.body;
    if (!Array.isArray(measurements)) return err(res, "measurements must be an array");

    visit.measurements = measurements;
    await visit.save();
    ok(res, visit, "Measurements updated");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── DELETE a measurement ────────────────────────────────────────────────────
const deleteMeasurement = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    visit.measurements = visit.measurements.filter((m) => String(m._id) !== req.params.measurementId);
    await visit.save();
    ok(res, visit, "Measurement removed");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PHOTOS
// ════════════════════════════════════════════════════════════════════════════

// ── ADD photos (batch) ──────────────────────────────────────────────────────
const addPhotos = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    const { photos } = req.body; // [{ url, caption, gps }]
    if (!Array.isArray(photos) || !photos.length) return err(res, "photos array required");

    photos.forEach((p) => {
      if (p.url) visit.photos.push({ url: p.url, caption: p.caption || "", gps: p.gps || undefined });
    });
    await visit.save();
    ok(res, visit, "Photos added");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── DELETE a photo ─────────────────────────────────────────────────────────
const deletePhoto = async (req, res) => {
  try {
    const visit = await SiteVisit.findById(req.params.id);
    if (!visit) return err(res, "Not found", 404);

    visit.photos = visit.photos.filter((p) => String(p._id) !== req.params.photoId);
    await visit.save();
    ok(res, visit, "Photo removed");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── SAVE sheet (observations + recommendation) ──────────────────────────────
const saveSheet = async (req, res) => {
  try {
    const { observations, recommendation } = req.body;
    const visit = await SiteVisit.findByIdAndUpdate(
      req.params.id,
      { $set: { observations: observations || "", recommendation: recommendation || "" } },
      { new: true }
    );
    if (!visit) return err(res, "Not found", 404);
    ok(res, visit, "Sheet saved");
  } catch (e) {
    err(res, e.message, 500);
  }
};

// ── CONVERT to job ──────────────────────────────────────────────────────────
const convertToJob = async (req, res) => {
  try {
    const { job_id } = req.body;
    const visit = await SiteVisit.findByIdAndUpdate(
      req.params.id,
      { $set: { converted_to_job: true, job_id: job_id || null, status: "converted" } },
      { new: true }
    );
    if (!visit) return err(res, "Not found", 404);
    ok(res, visit, "Converted to job");
  } catch (e) {
    err(res, e.message, 500);
  }
};

module.exports = {
  createSiteVisit,
  getAllSiteVisits,
  getVisitsByUser,
  getSiteVisit,
  updateSiteVisit,
  deleteSiteVisit,
  startSession,
  closeSession,
  getSessionStatus,
  inviteMember,
  removeMember,
  addMeasurement,
  updateMeasurements,
  deleteMeasurement,
  addPhotos,
  deletePhoto,
  saveSheet,
  convertToJob,
};