/**
 * staffMonitor.controller.js  (enhanced with break / lunch / OT / assigned tasks)
 *
 * OT RULE: Standard working day = 8 h (28 800 s).
 *   OT = max(0, working_seconds - 28800)  calculated on logout.
 *
 * ASSIGNED TASK LIFECYCLE:
 *   pending -> start -> in_progress -> complete -> completed
 *   in_progress -> stop (notes required) -> stopped
 *   stopped -> request-resume -> resume_requested -> (admin) resume -> in_progress
 *   stopped -> (admin) resume -> in_progress   [admin can bypass the request]
 */

const axios = require("axios");
const AdminUsersSchema = require("../modals/adminusers.modals");
const { StaffSession, StaffTaskLog, StaffAssignedTask } = require("../modals/Staffmonitor.model");
const Job = require("../modals/job.modal");
const SiteVisit = require("../modals/visit.modal");
const MaterialIssue = require("../modals/Material_issue.model");
const { successResponse, errorResponse } = require("../helper/response.helper");

const STANDARD_WORK_SECONDS = 10 * 3600; // 36 000

// ─── Auto-logout policy ────────────────────────────────────────────────────
// Everyone still logged in past 7 PM (IST) is automatically logged out,
// unless a super admin has approved an after-hours permission request that
// is still within its permitted window.
const IST_OFFSET_MS      = 5.5 * 60 * 60 * 1000;
const DEFAULT_PERMISSION_GRACE_MS = 2 * 3600 * 1000; // fallback: +2h if admin doesn't set a time

// ⚠️ TEST MODE ⚠️
// Set TEST_MODE = false to restore the real 7 PM (19:00 IST) cutoff.
// While true, the cutoff is computed once at server-start as
// "now + TEST_LOGOUT_DELAY_MINUTES" (in IST), so you can watch the sweep
// actually fire a few minutes after boot instead of waiting until evening.
const TEST_MODE = false;
const TEST_LOGOUT_DELAY_MINUTES = 1;

const computeAutoLogoutHour = () => {
  if (!TEST_MODE) return 19; // real 7 PM (19:00 IST)
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const hourNow = istNow.getUTCHours() + istNow.getUTCMinutes() / 60 + istNow.getUTCSeconds() / 3600;
  const testHour = hourNow + TEST_LOGOUT_DELAY_MINUTES / 60;
  console.log(
    `[staffMonitor][TEST_MODE] Auto-logout cutoff will fire in ~${TEST_LOGOUT_DELAY_MINUTES} min ` +
    `(IST hour threshold: ${testHour.toFixed(4)})`
  );
  return testHour;
};

const AUTO_LOGOUT_HOUR = computeAutoLogoutHour();

const toIST = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS);

// ⚠️ BUG FIX ⚠️
// This used to compare `toIST(d).getUTCHours()` (an INTEGER hour, e.g. 14)
// against AUTO_LOGOUT_HOUR (a fractional hour, e.g. 14.0167 for "14:01").
// 14 >= 14.0167 is false for the ENTIRE rest of that hour — so in test mode
// the sweep didn't fire after N minutes, it only fired whenever the clock
// happened to roll over to the next hour. Now both sides use fractional
// hours so a threshold like "+1 minute" actually means +1 minute.
const isPastAutoLogoutTime = (d = new Date()) => {
  const ist = toIST(d);
  const hourFrac = ist.getUTCHours() + ist.getUTCMinutes() / 60 + ist.getUTCSeconds() / 3600;
  return hourFrac >= AUTO_LOGOUT_HOUR;
};

// ─── Shared session-close helpers ──────────────────────────────────────────
// Used by manual logout, admin force-logout, and the auto-logout sweep so
// duration/OT/break math stays identical no matter who/what closes the session.
const closeBreakIfAny = (session, now) => {
  if (session.active_break?.start) {
    const bSecs = Math.max(0, Math.floor((now - session.active_break.start) / 1000));
    const lastBreak = session.breaks[session.breaks.length - 1];
    if (lastBreak && !lastBreak.end) {
      lastBreak.end = now;
      lastBreak.duration_seconds = bSecs;
    }
    session.break_seconds = (session.break_seconds || 0) + bSecs;
    session.active_break  = { type: null, start: null };
  }
};

const finalizeSession = (session, now, extra = {}) => {
  session.logout_at        = now;
  session.duration_seconds = Math.max(0, Math.floor((now - session.login_at) / 1000));
  session.working_seconds  = Math.max(0, session.duration_seconds - (session.break_seconds || 0));
  session.overtime_seconds = Math.max(0, session.working_seconds - STANDARD_WORK_SECONDS);
  session.logout_type      = extra.logout_type || "manual";
  if (extra.forced_logout_by)      session.forced_logout_by      = extra.forced_logout_by;
  if (extra.forced_logout_by_name) session.forced_logout_by_name = extra.forced_logout_by_name;
};

// ─── Utilities ───────────────────────────────────────────────────────────────
const todayStr  = () => new Date().toISOString().slice(0, 10);
const secsToDisplay = (total) => {
  const s   = Math.max(0, Math.floor(total));
  const h   = String(Math.floor(s / 3600)).padStart(2, "0");
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

const reverseGeocode = async (lat, lng) => {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`;
    const { data } = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "JobSheetApp/1.0", "Accept-Language": "en" },
    });
    const addr  = data?.address || {};
    const display = data?.display_name || "";
    const parts = [
      addr.road || addr.pedestrian || addr.footway || "",
      addr.suburb || addr.neighbourhood || "",
      addr.city || addr.town || addr.village || "",
      addr.state || "",
    ].filter(Boolean);
    return {
      formatted_address: parts.length ? parts.join(", ") : display,
      place_name: addr.city || addr.town || addr.village || addr.suburb || "",
    };
  } catch (err) {
    return { formatted_address: "", place_name: "" };
  }
};

const extractUserWorkFromStages = (stages = [], userId) => {
  const result = [];
  let totalSeconds = 0;
  for (const stage of stages) {
    if (stage.handled_by?.user_id?.toString() !== userId) continue;
    const userSessions = (stage.work_sessions || []).filter(
      (s) => !s.user_id || s.user_id?.toString() === userId,
    );
    let stageSecs = 0;
    const sessions = userSessions.map((s) => {
      let secs = 0;
      if (s.session_start) {
        const end = s.session_end ? new Date(s.session_end) : new Date();
        secs = Math.max(0, Math.floor((end - new Date(s.session_start)) / 1000));
      }
      stageSecs += secs;
      return {
        session_start:    s.session_start,
        session_end:      s.session_end || null,
        duration_seconds: secs,
        duration_display: secsToDisplay(secs),
        work_date:        s.work_date || (s.session_start ? new Date(s.session_start).toISOString().slice(0, 10) : ""),
        is_open:          !s.session_end,
      };
    });
    totalSeconds += stageSecs;
    result.push({
      stage:                  stage.stage,
      stage_label:            stage.stage_label || stage.stage,
      action:                 stage.action,
      assigned_at:            stage.assigned_at,
      started_at:             stage.started_at,
      completed_at:           stage.completed_at,
      total_duration_seconds: stageSecs,
      total_duration_display: secsToDisplay(stageSecs),
      sessions,
      has_open_session:       sessions.some((s) => s.is_open),
    });
  }
  return { stages: result, totalSeconds };
};

// ─── Assigned-task helpers ────────────────────────────────────────────────
const computeTaskLiveSeconds = (task) => {
  let total = task.total_seconds || 0;
  if (task.status === "in_progress") {
    const openSession = (task.sessions || []).find((s) => s.start && !s.end);
    if (openSession) total += Math.max(0, Math.floor((Date.now() - new Date(openSession.start).getTime()) / 1000));
  }
  return total;
};
const serializeTask = (task) => {
  const obj = typeof task.toObject === "function" ? task.toObject() : task;
  const liveSeconds = computeTaskLiveSeconds(obj);
  return { ...obj, live_seconds: liveSeconds, live_display: secsToDisplay(liveSeconds) };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/login
// ─────────────────────────────────────────────────────────────────────────────
const recordLogin = async (req, res) => {
  try {
    const { staffId, selfie_url, latitude, longitude, accuracy } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const staff = await AdminUsersSchema.findById(staffId).select("name role isOnline").lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const now = new Date();
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (openSession) {
      // Staff is logging in again while an old session was still open
      // (e.g. they closed the browser tab without logging out). Close it
      // out cleanly rather than leaving it dangling forever.
      closeBreakIfAny(openSession, now);
      finalizeSession(openSession, now, { logout_type: "manual" });
      await openSession.save();
    }

    const hasCoords = latitude != null && longitude != null;
    let locationData = { latitude: null, longitude: null, accuracy: null, formatted_address: "", place_name: "" };
    if (hasCoords) {
      const lat = parseFloat(latitude), lng = parseFloat(longitude);
      const geo = await reverseGeocode(lat, lng);
      locationData = {
        latitude: lat, longitude: lng,
        accuracy: accuracy != null ? parseFloat(accuracy) : null,
        formatted_address: geo.formatted_address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        place_name: geo.place_name,
      };
    }

    const session = await StaffSession.create({
      staff_id: staffId, login_at: now, date: todayStr(),
      login_ip: req.ip || req.headers["x-forwarded-for"] || "",
      selfie_url: selfie_url || "", location: locationData,
      breaks: [], active_break: { type: null, start: null },
      break_seconds: 0, working_seconds: 0, overtime_seconds: 0,
    });

    await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: true });
    return successResponse(res, "Login recorded.", { session });
  } catch (err) {
    console.error("[recordLogin]", err);
    return errorResponse(res, "Failed to record login.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/logout
// ─────────────────────────────────────────────────────────────────────────────
const recordLogout = async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const now = new Date();
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (openSession) {
      closeBreakIfAny(openSession, now);
      finalizeSession(openSession, now, { logout_type: "manual" });
      await openSession.save();
    }
    await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: false });
    const ot = openSession?.overtime_seconds || 0;
    return successResponse(res, "Logout recorded.", { overtime_seconds: ot, overtime_display: secsToDisplay(ot) });
  } catch (err) {
    console.error("[recordLogout]", err);
    return errorResponse(res, "Failed to record logout.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/force-logout   body: { staffId }   (super admin only)
// Lets a super admin close out a staff member's session when they "didn't
// log out correctly" (forgot to log out, app crashed, left it open, etc.)
// ─────────────────────────────────────────────────────────────────────────────
const forceLogout = async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");

    const now = new Date();
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });

    if (!openSession) {
      // Nothing open in the DB, but isOnline flag might be stuck true — sync it.
      await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: false });
      return errorResponse(res, "No active session found for this staff member. Their online status has been reset.");
    }

    closeBreakIfAny(openSession, now);
    finalizeSession(openSession, now, {
      logout_type: "forced_admin",
      forced_logout_by: req.user?._id || null,
      forced_logout_by_name: req.user?.name || "Super Admin",
    });
    // Any pending after-hours request becomes moot once they're force-logged-out.
    if (openSession.permission?.status === "pending") {
      openSession.permission.status = "rejected";
      openSession.permission.responded_by = req.user?._id || null;
      openSession.permission.responded_by_name = req.user?.name || "Super Admin";
      openSession.permission.responded_at = now;
      openSession.permission.response_note = "Auto-closed: staff was logged out by admin.";
    }
    await openSession.save();
    await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: false });

    return successResponse(res, "Staff member has been logged out.", {
      overtime_seconds: openSession.overtime_seconds,
      overtime_display: secsToDisplay(openSession.overtime_seconds),
      logout_type: openSession.logout_type,
    });
  } catch (err) {
    console.error("[forceLogout]", err);
    return errorResponse(res, "Failed to force logout.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/permission/request   body: { staffId, reason, requested_until }
// Staff asks for permission to keep working past the 7 PM auto-logout cutoff.
// ─────────────────────────────────────────────────────────────────────────────
const requestPermission = async (req, res) => {
  try {
    const { staffId, reason, requested_until } = req.body;
    if (!staffId)         return errorResponse(res, "staffId is required.");
    if (!reason?.trim())  return errorResponse(res, "Please provide a reason for working after 7 PM.");

    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active session found. Please log in first.");

    if (session.permission?.status === "pending") {
      return errorResponse(res, "You already have a pending permission request.");
    }
    if (session.permission?.status === "approved" && session.permission?.permitted_until && new Date(session.permission.permitted_until) > new Date()) {
      return errorResponse(res, "You already have approved permission to work late.");
    }

    const now = new Date();
    session.permission = {
      status: "pending",
      reason: reason.trim(),
      requested_at: now,
      requested_until: requested_until ? new Date(requested_until) : null,
      responded_by: null,
      responded_by_name: "",
      responded_at: null,
      permitted_until: null,
      response_note: "",
    };
    await session.save();

    return successResponse(res, "Permission requested. Waiting for super admin approval.", { permission: session.permission });
  } catch (err) {
    console.error("[requestPermission]", err);
    return errorResponse(res, "Failed to request permission.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /session/permission/pending   (super admin only)
// ─────────────────────────────────────────────────────────────────────────────
const getPendingPermissions = async (req, res) => {
  try {
    const sessions = await StaffSession.find({ logout_at: null, "permission.status": "pending" })
      .populate("staff_id", "name email role profileImg")
      .sort({ "permission.requested_at": -1 })
      .lean();
    return successResponse(res, "Pending permission requests fetched.", sessions);
  } catch (err) {
    console.error("[getPendingPermissions]", err);
    return errorResponse(res, "Failed to fetch pending permission requests.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/permission/:staffId/respond
// body: { status: "approved"|"rejected", permitted_until?, note? }   (super admin only)
// ─────────────────────────────────────────────────────────────────────────────
const respondPermission = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { status, permitted_until, note } = req.body;
    if (!["approved", "rejected"].includes(status)) {
      return errorResponse(res, "status must be 'approved' or 'rejected'.");
    }

    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active session found for this staff member.");
    if (session.permission?.status !== "pending") {
      return errorResponse(res, "There is no pending permission request for this staff member.");
    }

    const now = new Date();
    session.permission.status             = status;
    session.permission.responded_by       = req.user?._id || null;
    session.permission.responded_by_name  = req.user?.name || "Super Admin";
    session.permission.responded_at       = now;
    session.permission.response_note      = note?.trim() || "";

    if (status === "approved") {
      session.permission.permitted_until = permitted_until
        ? new Date(permitted_until)
        : new Date(now.getTime() + DEFAULT_PERMISSION_GRACE_MS);
    } else {
      session.permission.permitted_until = null;
    }
    await session.save();

    return successResponse(res, `Permission ${status}.`, { permission: session.permission });
  } catch (err) {
    console.error("[respondPermission]", err);
    return errorResponse(res, "Failed to respond to permission request.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Auto-logout sweep — call periodically (see index.js).
// After 7 PM IST, anyone still logged in gets logged out automatically
// UNLESS they have an admin-approved permission whose window hasn't expired.
// ─────────────────────────────────────────────────────────────────────────────
const runAutoLogoutSweep = async () => {
  try {
    if (!isPastAutoLogoutTime()) return { checked: 0, loggedOut: 0 };

    const now = new Date();
    const openSessions = await StaffSession.find({ logout_at: null });
    let loggedOut = 0;

    for (const session of openSessions) {
      const perm = session.permission || {};
      const stillPermitted =
        perm.status === "approved" &&
        perm.permitted_until &&
        new Date(perm.permitted_until) > now;

      if (stillPermitted) continue; // they're allowed to keep working for now

      const logoutType = perm.status === "approved" ? "auto_permission_expired" : "auto_7pm";

      closeBreakIfAny(session, now);
      finalizeSession(session, now, { logout_type: logoutType });
      await session.save();
      await AdminUsersSchema.findByIdAndUpdate(session.staff_id, { isOnline: false });
      loggedOut += 1;
    }

    if (loggedOut) console.log(`[runAutoLogoutSweep] Auto-logged-out ${loggedOut} staff past the 7 PM cutoff.`);
    return { checked: openSessions.length, loggedOut };
  } catch (err) {
    console.error("[runAutoLogoutSweep]", err);
    return { checked: 0, loggedOut: 0, error: true };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/break/start   body: { staffId, breakType: "break"|"lunch" }
// ─────────────────────────────────────────────────────────────────────────────
const startBreak = async (req, res) => {
  try {
    const { staffId, breakType = "break" } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active session found.");
    if (session.active_break?.start) return errorResponse(res, "Already on break.");
    const now = new Date();
    session.active_break = { type: breakType, start: now };
    session.breaks.push({ type: breakType, start: now, end: null, duration_seconds: 0 });
    await session.save();
    return successResponse(res, `${breakType} started.`, { break_start: now, type: breakType });
  } catch (err) {
    console.error("[startBreak]", err);
    return errorResponse(res, "Failed to start break.");
  }
};

const getSession = async (req, res) => {
  try {
    const { staffId } = req.params;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active session found.");
    return successResponse(res, "Session fetched.", {
      login_at:       session.login_at,
      active_break:   session.active_break,
      break_seconds:  session.break_seconds || 0,
      permission:     session.permission || { status: "none" },
      auto_logout_hour: AUTO_LOGOUT_HOUR,
      is_past_auto_logout_time: isPastAutoLogoutTime(),
    });
  } catch (err) {
    console.error("[getSession]", err);
    return errorResponse(res, "Failed to fetch session.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/break/end   body: { staffId }
// ─────────────────────────────────────────────────────────────────────────────
const endBreak = async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active session found.");
    if (!session.active_break?.start) return errorResponse(res, "Not on break.");
    const now   = new Date();
    const bSecs = Math.max(0, Math.floor((now - session.active_break.start) / 1000));
    const lastBreak = session.breaks[session.breaks.length - 1];
    if (lastBreak && !lastBreak.end) {
      lastBreak.end = now;
      lastBreak.duration_seconds = bSecs;
    }
    session.break_seconds = (session.break_seconds || 0) + bSecs;
    session.active_break  = { type: null, start: null };
    await session.save();
    return successResponse(res, "Break ended.", { break_seconds: bSecs, break_display: secsToDisplay(bSecs), total_break_seconds: session.break_seconds });
  } catch (err) {
    console.error("[endBreak]", err);
    return errorResponse(res, "Failed to end break.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /monitor
// ─────────────────────────────────────────────────────────────────────────────
const getMonitorList = async (req, res) => {
  try {
    const today     = todayStr();
    const staffList = await AdminUsersSchema.find({}, { name:1, email:1, role:1, profileImg:1, isOnline:1, available:1 }).lean();
    const staffIds  = staffList.map((s) => s._id);
    const staffIdStrs = staffIds.map((id) => id.toString());

    const todaySessions = await StaffSession.find({ staff_id: { $in: staffIds }, date: today }).lean();

    const latestSelfieAgg = await StaffSession.aggregate([
      { $match: { staff_id: { $in: staffIds }, selfie_url: { $nin: [null, ""] } } },
      { $sort: { login_at: -1 } },
      { $group: { _id: "$staff_id", selfie_url: { $first: "$selfie_url" }, location: { $first: "$location" }, login_at: { $first: "$login_at" } } },
    ]);
    const selfieMap = {};
    for (const s of latestSelfieAgg) selfieMap[s._id.toString()] = { selfie_url: s.selfie_url, location: s.location, login_at: s.login_at };

    const startOfDay = new Date(`${today}T00:00:00.000Z`);
    const endOfDay   = new Date(`${today}T23:59:59.999Z`);
    const taskLogCounts = await StaffTaskLog.aggregate([
      { $match: { staff_id: { $in: staffIds }, submitted_at: { $gte: startOfDay, $lte: endOfDay } } },
      { $group: { _id: "$staff_id", count: { $sum: 1 }, lastAt: { $max: "$submitted_at" } } },
    ]);
    const taskMap = {};
    for (const t of taskLogCounts) taskMap[t._id.toString()] = t;

    // Assigned task summary per staff
    const assignedTaskAgg = await StaffAssignedTask.aggregate([
      { $match: { staff_id: { $in: staffIds } } },
      { $group: {
          _id: "$staff_id",
          total: { $sum: 1 },
          pending: { $sum: { $cond: [{ $eq: ["$status","pending"] }, 1, 0] } },
          active:  { $sum: { $cond: [{ $eq: ["$status","in_progress"] }, 1, 0] } },
          stopped: { $sum: { $cond: [{ $eq: ["$status","stopped"] }, 1, 0] } },
          resumeRequested: { $sum: { $cond: [{ $eq: ["$status","resume_requested"] }, 1, 0] } },
        } },
    ]);
    const assignedTaskMap = {};
    for (const a of assignedTaskAgg) assignedTaskMap[a._id.toString()] = a;

    const assignedJobs = await Job.find({ "workflow_stages.handled_by.user_id": { $in: staffIds } })
      .select("job_no customer_name job_status current_stage workflow_stages").lean();

    const jobStatsMap = {};
    for (const id of staffIdStrs) jobStatsMap[id] = { activeJobs: 0, totalJobSecondsToday: 0, totalJobSecondsAll: 0, jobsAssignedTotal: 0 };

    for (const job of assignedJobs) {
      for (const stage of job.workflow_stages || []) {
        const handlerId = stage.handled_by?.user_id?.toString();
        if (!handlerId || !jobStatsMap[handlerId]) continue;
        jobStatsMap[handlerId].jobsAssignedTotal += 1;
        const hasOpen = (stage.work_sessions || []).some((s) => s.session_start && !s.session_end);
        if (hasOpen) jobStatsMap[handlerId].activeJobs += 1;
        for (const sess of stage.work_sessions || []) {
          if (!sess.session_start) continue;
          const end  = sess.session_end ? new Date(sess.session_end) : new Date();
          const secs = Math.max(0, Math.floor((end - new Date(sess.session_start)) / 1000));
          jobStatsMap[handlerId].totalJobSecondsAll += secs;
          const sessionDate = (sess.work_date || new Date(sess.session_start).toISOString()).slice(0, 10);
          if (sessionDate === today) jobStatsMap[handlerId].totalJobSecondsToday += secs;
        }
      }
    }

    const sessionMap = {};
    for (const s of todaySessions) {
      const key = s.staff_id.toString();
      if (!sessionMap[key]) sessionMap[key] = [];
      sessionMap[key].push(s);
    }

    const result = staffList.map((staff) => {
      const id       = staff._id.toString();
      const sessions = sessionMap[id] || [];
      const taskInfo = taskMap[id] || { count: 0, lastAt: null };
      const js       = jobStatsMap[id] || {};
      const at       = assignedTaskMap[id] || { total: 0, pending: 0, active: 0, stopped: 0, resumeRequested: 0 };

      const todaySeconds = sessions.reduce((acc, s) => {
        if (s.logout_at) return acc + (s.duration_seconds || 0);
        return acc + Math.floor((Date.now() - new Date(s.login_at).getTime()) / 1000);
      }, 0);

      const breakSecondsToday  = sessions.reduce((a, s) => a + (s.break_seconds || 0), 0);
      const workingSecondsToday = sessions.reduce((acc, s) => {
        if (s.logout_at) return acc + (s.working_seconds || 0);
        const raw = Math.floor((Date.now() - new Date(s.login_at).getTime()) / 1000);
        return acc + Math.max(0, raw - (s.break_seconds || 0));
      }, 0);
      const overtimeSecondsToday = sessions.reduce((a, s) => a + (s.overtime_seconds || 0), 0);

      const openSession  = sessions.find((s) => !s.logout_at);
      const onBreak      = !!(openSession?.active_break?.start);
      const breakType    = openSession?.active_break?.type || null;
      const lastLogout   = sessions.filter((s) => s.logout_at).sort((a, b) => new Date(b.logout_at) - new Date(a.logout_at))[0]?.logout_at;
      const lastActivity = taskInfo.lastAt > lastLogout ? taskInfo.lastAt : lastLogout;

      // "Didn't log out correctly" — an open session that started before
      // today (crossed midnight without anyone closing it out).
      const staleOpenSession = !!(openSession && openSession.date !== today);

      const permission = openSession?.permission?.status && openSession.permission.status !== "none"
        ? {
            status:           openSession.permission.status,
            reason:           openSession.permission.reason,
            requested_at:     openSession.permission.requested_at,
            requested_until:  openSession.permission.requested_until,
            permitted_until:  openSession.permission.permitted_until,
          }
        : null;

      return {
        ...staff,
        todaySeconds,
        todaySessions:         sessions.length,
        taskLogsToday:         taskInfo.count,
        currentLoginAt:        openSession?.login_at || null,
        lastActivity:          lastActivity || null,
        latestSelfie:          selfieMap[id] || null,
        onBreak,
        breakType,
        breakSecondsToday,
        workingSecondsToday,
        overtimeSecondsToday,
        overtimeDisplay:       secsToDisplay(overtimeSecondsToday),
        staleOpenSession,       // didn't log out correctly (crossed midnight still online)
        permission,             // current after-7pm permission request/approval, if any
        jobStats: {
          activeJobs:           js.activeJobs ?? 0,
          totalJobSecondsToday: js.totalJobSecondsToday ?? 0,
          totalJobSecondsAll:   js.totalJobSecondsAll ?? 0,
          totalJobDisplayToday: secsToDisplay(js.totalJobSecondsToday ?? 0),
          totalJobDisplayAll:   secsToDisplay(js.totalJobSecondsAll ?? 0),
          jobsAssignedTotal:    js.jobsAssignedTotal ?? 0,
        },
        assignedTaskStats: {
          total: at.total, pending: at.pending, active: at.active,
          stopped: at.stopped, resumeRequested: at.resumeRequested,
        },
      };
    });

    result.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return successResponse(res, "Monitor list fetched.", result);
  } catch (err) {
    console.error("[getMonitorList]", err);
    return errorResponse(res, "Failed to fetch monitor list.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /monitor/:id/details
// ─────────────────────────────────────────────────────────────────────────────
const getStaffDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const staff  = await AdminUsersSchema.findById(id, { password: 0 }).lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const sessions  = await StaffSession.find({ staff_id: id }).sort({ login_at: -1 }).lean();
    const taskLogs  = await StaffTaskLog.find({ staff_id: id }).sort({ submitted_at: -1 }).lean();
    const assignedTasks = await StaffAssignedTask.find({ staff_id: id }).sort({ assigned_at: -1 }).lean();

    const assignedJobs = await Job.find({ "workflow_stages.handled_by.user_id": id })
      .select("job_no customer_name company_name job_status current_stage workflow_stages order_date createdAt").lean();

    let totalJobSeconds = 0, activeJobCount = 0;
    const jobAssignments = assignedJobs.map((job) => {
      const { stages, totalSeconds } = extractUserWorkFromStages(job.workflow_stages, id);
      const isCurrentlyActive = stages.some((s) => s.has_open_session);
      totalJobSeconds += totalSeconds;
      if (isCurrentlyActive) activeJobCount += 1;
      return { _id: job._id, job_no: job.job_no, customer_name: job.customer_name, company_name: job.company_name || "", job_status: job.job_status, order_date: job.order_date || job.createdAt, current_stage: job.current_stage, stages, totalSeconds, totalDisplay: secsToDisplay(totalSeconds), isCurrentlyActive };
    });
    jobAssignments.sort((a, b) => a.isCurrentlyActive !== b.isCurrentlyActive ? (a.isCurrentlyActive ? -1 : 1) : b.totalSeconds - a.totalSeconds);

    const totalBreakSeconds    = sessions.reduce((a, s) => a + (s.break_seconds || 0), 0);
    const totalWorkingSeconds  = sessions.reduce((a, s) => a + (s.working_seconds || 0), 0);
    const totalOvertimeSeconds = sessions.reduce((a, s) => a + (s.overtime_seconds || 0), 0);

    const assignedSiteVisits = await SiteVisit.find({
      $or: [
        { "assigned_to.user_id": id },
        { "team_members.user_id": id },
      ],
    })
      .select("visit_no customer_name company_name city address_line1 visit_date status assigned_to team_members")
      .sort({ visit_date: -1 })
      .lean()
      .catch(() => []);

    const issuedMaterials = await MaterialIssue.find({ "issued_to.user_id": id })
      .select("issue_no job_no cart_item_name status issued_qty material return pickup_assignment outsource_vendor")
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => []);

    const allPickups = await MaterialIssue.find({ "pickup_assignment.assigned_to.user_id": id })
      .select("issue_no job_no outsource_vendor pickup_assignment")
      .sort({ "pickup_assignment.assigned_at": -1 })
      .lean()
      .catch(() => []);

    const pendingPickups   = allPickups.filter(p => p.pickup_assignment?.status === "pending");
    const completedPickups = allPickups.filter(p => ["collected", "delivered"].includes(p.pickup_assignment?.status));

    const allTaskAssignments = {
      totalJobs:         jobAssignments.length,
      activeJobs:        activeJobCount,
      totalSiteVisits:   assignedSiteVisits.length,
      pendingPickups:    pendingPickups.length,
      completedPickups:  completedPickups.length,
      issuedMaterials:   issuedMaterials.length,
      pendingMaterials:  issuedMaterials.filter(m => m.status === "issued").length,
      returnedMaterials: issuedMaterials.filter(m => ["returned", "partial_return"].includes(m.status)).length,
    };

    return successResponse(res, "Staff details fetched.", {
      staff, sessions, taskLogs, jobAssignments,
      assignedTasks: assignedTasks.map(serializeTask),
      jobTimeSummary: { totalSeconds: totalJobSeconds, totalDisplay: secsToDisplay(totalJobSeconds), activeJobCount, jobCount: jobAssignments.length },
      attendanceSummary: {
        totalBreakSeconds,    breakDisplay:    secsToDisplay(totalBreakSeconds),
        totalWorkingSeconds,  workingDisplay:  secsToDisplay(totalWorkingSeconds),
        totalOvertimeSeconds, overtimeDisplay: secsToDisplay(totalOvertimeSeconds),
      },
      assignedSiteVisits,
      issuedMaterials,
      pendingPickups,
      completedPickups,
      allTaskAssignments,
    });
  } catch (err) {
    console.error("[getStaffDetails]", err);
    return errorResponse(res, "Failed to fetch details.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /monitor/:id/job-time
// ─────────────────────────────────────────────────────────────────────────────
const getStaffJobTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { jobNo } = req.query;
    const staff = await AdminUsersSchema.findById(id, { name:1, role:1, email:1, profileImg:1 }).lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const jobFilter = { "workflow_stages.handled_by.user_id": id };
    if (jobNo) jobFilter.job_no = jobNo;

    const assignedJobs = await Job.find(jobFilter)
      .select("job_no customer_name company_name job_status current_stage workflow_stages order_date createdAt estimated_delivery_date").lean();

    let totalSeconds = 0, activeJobCount = 0;
    const jobs = assignedJobs.map((job) => {
      const { stages, totalSeconds: jobSecs } = extractUserWorkFromStages(job.workflow_stages, id);
      const isCurrentlyActive = stages.some((s) => s.has_open_session);
      totalSeconds += jobSecs;
      if (isCurrentlyActive) activeJobCount += 1;
      return { _id: job._id, job_no: job.job_no, customer_name: job.customer_name, company_name: job.company_name || "", job_status: job.job_status, order_date: job.order_date || job.createdAt, estimated_delivery_date: job.estimated_delivery_date, current_stage: job.current_stage, totalSeconds: jobSecs, totalDisplay: secsToDisplay(jobSecs), isCurrentlyActive, stages };
    });
    jobs.sort((a, b) => a.isCurrentlyActive !== b.isCurrentlyActive ? (a.isCurrentlyActive ? -1 : 1) : b.totalSeconds - a.totalSeconds);

    return successResponse(res, "Staff job time fetched.", { staff, summary: { totalSeconds, totalDisplay: secsToDisplay(totalSeconds), activeJobCount, jobCount: jobs.length }, jobs });
  } catch (err) {
    console.error("[getStaffJobTime]", err);
    return errorResponse(res, "Failed to fetch job time.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /task-log
// ─────────────────────────────────────────────────────────────────────────────
const submitTaskLog = async (req, res) => {
  try {
    const { staffId, message, job_ref, hour_label } = req.body;
    if (!staffId)         return errorResponse(res, "staffId is required.");
    if (!message?.trim()) return errorResponse(res, "message is required.");
    const now   = new Date();
    const label = hour_label || now.toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", hour12:true });
    const log   = await StaffTaskLog.create({ staff_id: staffId, message: message.trim(), job_ref: job_ref?.trim() || "", hour_label: label, submitted_at: now, submitted_by: req.user?._id || null });
    return successResponse(res, "Task log submitted.", log);
  } catch (err) {
    console.error("[submitTaskLog]", err);
    return errorResponse(res, "Failed to submit task log.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /task-log/:logId
// ─────────────────────────────────────────────────────────────────────────────
const deleteTaskLog = async (req, res) => {
  try {
    const { logId } = req.params;
    const deleted   = await StaffTaskLog.findByIdAndDelete(logId);
    if (!deleted) return errorResponse(res, "Log entry not found.");
    return successResponse(res, "Log deleted.");
  } catch (err) {
    console.error("[deleteTaskLog]", err);
    return errorResponse(res, "Failed to delete log.");
  }
};

// ═════════════════════════════════════════════════════════════════════════
// ASSIGNED TASKS
// ═════════════════════════════════════════════════════════════════════════

// POST /assigned-task   body: { staffIds: [...], tasks: [{ title, description, estimated_hours, due_at }] }
const assignTask = async (req, res) => {
  try {
    const { staffIds, tasks } = req.body;
    if (!Array.isArray(staffIds) || !staffIds.length) return errorResponse(res, "staffIds is required.");
    if (!Array.isArray(tasks) || !tasks.length) return errorResponse(res, "At least one task is required.");
    if (tasks.some((t) => !t.title?.trim())) return errorResponse(res, "Every task requires a title.");

    const docs = [];
    for (const staffId of staffIds) {
      for (const t of tasks) {
        docs.push({
          staff_id: staffId,
          title: t.title.trim(),
          description: t.description?.trim() || "",
          estimated_hours: t.estimated_hours ? Number(t.estimated_hours) : 0,
          due_at: t.due_at ? new Date(t.due_at) : null,
          assigned_by: req.user?._id || null,
          assigned_by_name: req.user?.name || "Admin",
          status: "pending",
        });
      }
    }
    const created = await StaffAssignedTask.insertMany(docs);
    return successResponse(res, "Task(s) assigned.", created.map(serializeTask));
  } catch (err) {
    console.error("[assignTask]", err);
    return errorResponse(res, "Failed to assign task(s).");
  }
};

// GET /assigned-task/staff/:staffId   ?status=
const getAssignedTasksForStaff = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { status } = req.query;
    const filter = { staff_id: staffId };
    if (status) filter.status = status;
    const tasks = await StaffAssignedTask.find(filter).sort({ assigned_at: -1 }).lean();
    return successResponse(res, "Tasks fetched.", tasks.map(serializeTask));
  } catch (err) {
    console.error("[getAssignedTasksForStaff]", err);
    return errorResponse(res, "Failed to fetch tasks.");
  }
};

// GET /assigned-task   ?status=   (admin, across all staff)
const getAllAssignedTasks = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const tasks = await StaffAssignedTask.find(filter)
      .populate("staff_id", "name email profileImg role")
      .sort({ assigned_at: -1 })
      .lean();
    return successResponse(res, "Tasks fetched.", tasks.map(serializeTask));
  } catch (err) {
    console.error("[getAllAssignedTasks]", err);
    return errorResponse(res, "Failed to fetch tasks.");
  }
};

// POST /assigned-task/:taskId/start   (staff)
const startAssignedTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await StaffAssignedTask.findById(taskId);
    if (!task) return errorResponse(res, "Task not found.");
    if (task.status !== "pending") return errorResponse(res, `Cannot start a task that is ${task.status}.`);
    const now = new Date();
    task.sessions.push({ start: now, end: null, duration_seconds: 0 });
    task.status = "in_progress";
    task.started_at = task.started_at || now;
    await task.save();
    return successResponse(res, "Task started.", serializeTask(task));
  } catch (err) {
    console.error("[startAssignedTask]", err);
    return errorResponse(res, "Failed to start task.");
  }
};

// POST /assigned-task/:taskId/stop   body: { notes }   (staff) — notes required, opens popup on frontend
const stopAssignedTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { notes } = req.body;
    if (!notes?.trim()) return errorResponse(res, "Notes are required to stop a task.");
    const task = await StaffAssignedTask.findById(taskId);
    if (!task) return errorResponse(res, "Task not found.");
    if (task.status !== "in_progress") return errorResponse(res, "Task is not in progress.");
    const now = new Date();
    const openSession = task.sessions[task.sessions.length - 1];
    let secs = 0;
    if (openSession && !openSession.end) {
      secs = Math.max(0, Math.floor((now - openSession.start) / 1000));
      openSession.end = now;
      openSession.duration_seconds = secs;
    }
    task.total_seconds = (task.total_seconds || 0) + secs;
    task.status = "stopped";
    task.stop_notes = notes.trim();
    task.stop_history.push({ notes: notes.trim(), stopped_at: now });
    task.resume_requested_at = null;
    await task.save();
    return successResponse(res, "Task stopped.", serializeTask(task));
  } catch (err) {
    console.error("[stopAssignedTask]", err);
    return errorResponse(res, "Failed to stop task.");
  }
};

// POST /assigned-task/:taskId/complete   (staff)
const completeAssignedTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await StaffAssignedTask.findById(taskId);
    if (!task) return errorResponse(res, "Task not found.");
    if (task.status !== "in_progress") return errorResponse(res, "Only an in-progress task can be completed.");
    const now = new Date();
    const openSession = task.sessions[task.sessions.length - 1];
    let secs = 0;
    if (openSession && !openSession.end) {
      secs = Math.max(0, Math.floor((now - openSession.start) / 1000));
      openSession.end = now;
      openSession.duration_seconds = secs;
    }
    task.total_seconds = (task.total_seconds || 0) + secs;
    task.status = "completed";
    task.completed_at = now;
    await task.save();
    return successResponse(res, "Task completed.", serializeTask(task));
  } catch (err) {
    console.error("[completeAssignedTask]", err);
    return errorResponse(res, "Failed to complete task.");
  }
};

// POST /assigned-task/:taskId/request-resume   (staff) — asks admin for permission
const requestResumeTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await StaffAssignedTask.findById(taskId);
    if (!task) return errorResponse(res, "Task not found.");
    if (task.status !== "stopped") return errorResponse(res, "Only a stopped task can request resume.");
    task.status = "resume_requested";
    task.resume_requested_at = new Date();
    await task.save();
    return successResponse(res, "Resume requested. Waiting for admin approval.", serializeTask(task));
  } catch (err) {
    console.error("[requestResumeTask]", err);
    return errorResponse(res, "Failed to request resume.");
  }
};

// POST /assigned-task/:taskId/resume   (super admin only)
const resumeAssignedTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await StaffAssignedTask.findById(taskId);
    if (!task) return errorResponse(res, "Task not found.");
    if (!["stopped", "resume_requested"].includes(task.status)) return errorResponse(res, "Task cannot be resumed from its current state.");
    const now = new Date();
    task.sessions.push({ start: now, end: null, duration_seconds: 0 });
    task.status = "in_progress";
    task.resume_requested_at = null;
    await task.save();
    return successResponse(res, "Task resumed.", serializeTask(task));
  } catch (err) {
    console.error("[resumeAssignedTask]", err);
    return errorResponse(res, "Failed to resume task.");
  }
};

// DELETE /assigned-task/:taskId   (super admin only)
const deleteAssignedTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const deleted = await StaffAssignedTask.findByIdAndDelete(taskId);
    if (!deleted) return errorResponse(res, "Task not found.");
    return successResponse(res, "Task deleted.");
  } catch (err) {
    console.error("[deleteAssignedTask]", err);
    return errorResponse(res, "Failed to delete task.");
  }
};

module.exports = {
  recordLogin, recordLogout, startBreak, endBreak,
  getMonitorList, getStaffDetails, getStaffJobTime,
  submitTaskLog, deleteTaskLog, getSession,
  assignTask, getAssignedTasksForStaff, getAllAssignedTasks,
  startAssignedTask, stopAssignedTask, completeAssignedTask,
  requestResumeTask, resumeAssignedTask, deleteAssignedTask,
  // Force logout / after-hours permission / auto-logout
  forceLogout, requestPermission, getPendingPermissions,
  respondPermission, runAutoLogoutSweep,
};