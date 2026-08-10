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
const ExcelJS = require("exceljs");
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

// ─── Field Work (marketing "going out with an ETA") ────────────────────────
// There's no background cron in this app anymore (the 7 PM sweep was
// disabled — see index.js), so instead of relying on a scheduled job, we
// lazily check-and-flip "active" -> "frozen" any time a field-work session
// is read or acted upon (getSession, getMonitorList, and every field-work
// endpoint call this first). This mirrors how the old auto-logout sweep
// worked, just computed on read instead of on a timer.
// This is a REAL auto-logout, not just a UI badge: it finalizes the whole
// attendance session (same math as manual logout / admin force-logout) and
// flags the staff record so `recordLogin` (In Time) refuses to let them back
// in until a super admin calls resumeFieldWork or closeFieldWork.
const syncFieldWorkFreeze = async (session, staffId, now = new Date()) => {
  const fw = session.field_work;
  if (!fw || fw.status !== "active" || !fw.expected_end_at) return false;
  if (new Date(fw.expected_end_at) > now) return false;

  fw.status    = "frozen";
  fw.frozen_at = now;
  fw.history.push({ action: "frozen", at: now, by_name: "system", notes: "Estimated time elapsed — auto logged out." });

  closeBreakIfAny(session, now);
  finalizeSession(session, now, { logout_type: "auto_field_work_freeze" });

  const sid = staffId || session.staff_id;
  await AdminUsersSchema.findByIdAndUpdate(sid, {
    isOnline: false,
    attendance_blocked: true,
    attendance_blocked_reason: "Field-work estimated time elapsed. Waiting for admin to resume or close it.",
    attendance_blocked_session_id: session._id,
  });

  return true; // caller should still session.save()
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
    const staff = await AdminUsersSchema.findById(staffId).select("name role isOnline attendance_blocked attendance_blocked_reason").lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    if (staff.attendance_blocked) {
      return errorResponse(
        res,
        staff.attendance_blocked_reason ||
          "Your last field-work window froze and needs a super admin to resume or close it before you can log back in."
      );
    }

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
// PATCH /session/:sessionId/edit-time   (super admin only)
// body: { login_at, logout_at }  — logout_at may be null/omitted to mark the
// session as still open (e.g. correcting a wrongly-closed session).
//
// Recomputes duration_seconds / working_seconds / overtime_seconds from the
// corrected times (minus whatever break time was already recorded on this
// session) so every downstream view — the monitor dashboard, staff detail
// drawer, and the Excel exports — stays consistent with the edited times.
// Every edit is appended to `edit_history` for an audit trail.
// ─────────────────────────────────────────────────────────────────────────────
const editSessionTime = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { login_at, logout_at } = req.body;

    if (!login_at) return errorResponse(res, "login_at is required.");
    const newLogin = new Date(login_at);
    if (Number.isNaN(newLogin.getTime())) return errorResponse(res, "Invalid login_at.");

    let newLogout = null;
    if (logout_at) {
      newLogout = new Date(logout_at);
      if (Number.isNaN(newLogout.getTime())) return errorResponse(res, "Invalid logout_at.");
      if (newLogout <= newLogin) return errorResponse(res, "Logout time must be after login time.");
    }

    const session = await StaffSession.findById(sessionId);
    if (!session) return errorResponse(res, "Session not found.");

    const previousLoginAt  = session.login_at;
    const previousLogoutAt = session.logout_at;
    const now = new Date();

    session.login_at = newLogin;
    // Keep the "date" bucket (used by the monitor list and exports) in sync
    // with the corrected login time so it lands on the right day.
    session.date = newLogin.toISOString().slice(0, 10);

    if (newLogout) {
      session.logout_at        = newLogout;
      session.duration_seconds = Math.max(0, Math.floor((newLogout - newLogin) / 1000));
      session.working_seconds  = Math.max(0, session.duration_seconds - (session.break_seconds || 0));
      session.overtime_seconds = Math.max(0, session.working_seconds - STANDARD_WORK_SECONDS);
    } else {
      // No logout given — treat this session as still open / reopened.
      session.logout_at        = null;
      session.duration_seconds = 0;
      session.working_seconds  = 0;
      session.overtime_seconds = 0;
      session.logout_type      = undefined;
    }

    session.manually_edited = true;
    session.edit_history = session.edit_history || [];
    session.edit_history.push({
      edited_by: req.user?._id || null,
      edited_by_name: req.user?.name || "Super Admin",
      edited_at: now,
      previous_login_at: previousLoginAt,
      previous_logout_at: previousLogoutAt,
      new_login_at: newLogin,
      new_logout_at: newLogout,
    });

    await session.save();

    // If this was the staff member's most recent session, keep isOnline in sync
    // (e.g. re-opening a session should flip them back online).
    const latestSession = await StaffSession.findOne({ staff_id: session.staff_id }).sort({ login_at: -1 });
    if (latestSession && String(latestSession._id) === String(session._id)) {
      await AdminUsersSchema.findByIdAndUpdate(session.staff_id, { isOnline: !session.logout_at });
    }

    return successResponse(res, "Session time updated.", { session });
  } catch (err) {
    console.error("[editSessionTime]", err);
    return errorResponse(res, "Failed to update session time.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/manual-entry   (super admin only)
// body: { staffId, login_at, logout_at }
//
// Lets a super admin add a brand-new attendance entry for a staff member —
// e.g. they forgot to clock in/out that day, or attendance was taken on
// paper. logout_at may be omitted to create it as a currently-open session.
// Distinct from editSessionTime, which corrects an existing session; this
// creates one from scratch.
// ─────────────────────────────────────────────────────────────────────────────
const createManualSession = async (req, res) => {
  try {
    const { staffId, login_at, logout_at } = req.body;

    if (!staffId) return errorResponse(res, "staffId is required.");
    if (!login_at) return errorResponse(res, "login_at is required.");

    const newLogin = new Date(login_at);
    if (Number.isNaN(newLogin.getTime())) return errorResponse(res, "Invalid login_at.");

    let newLogout = null;
    if (logout_at) {
      newLogout = new Date(logout_at);
      if (Number.isNaN(newLogout.getTime())) return errorResponse(res, "Invalid logout_at.");
      if (newLogout <= newLogin) return errorResponse(res, "Logout time must be after login time.");
    }

    const staff = await AdminUsersSchema.findById(staffId, { name: 1 });
    if (!staff) return errorResponse(res, "Staff not found.");

    const now = new Date();
    const duration_seconds = newLogout ? Math.max(0, Math.floor((newLogout - newLogin) / 1000)) : 0;
    const working_seconds  = newLogout ? duration_seconds : 0;
    const overtime_seconds = newLogout ? Math.max(0, working_seconds - STANDARD_WORK_SECONDS) : 0;

    const session = await StaffSession.create({
      staff_id: staffId,
      date: newLogin.toISOString().slice(0, 10),
      login_at: newLogin,
      logout_at: newLogout,
      duration_seconds,
      working_seconds,
      overtime_seconds,
      break_seconds: 0,
      manually_edited: true,
      edit_history: [{
        edited_by: req.user?._id || null,
        edited_by_name: req.user?.name || "Super Admin",
        edited_at: now,
        previous_login_at: null,
        previous_logout_at: null,
        new_login_at: newLogin,
        new_logout_at: newLogout,
      }],
    });

    // If this new entry is the staff member's most recent session, keep
    // isOnline in sync (e.g. a manually-added open entry marks them online).
    const latestSession = await StaffSession.findOne({ staff_id: staffId }).sort({ login_at: -1 });
    if (latestSession && String(latestSession._id) === String(session._id)) {
      await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: !session.logout_at });
    }

    return successResponse(res, "Manual attendance entry added.", { session });
  } catch (err) {
    console.error("[createManualSession]", err);
    return errorResponse(res, "Failed to add manual attendance entry.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /staff/:staffId/pay-settings   (super admin only)
// body: { standard_hours_per_day, monthly_salary }
//
// Sets the per-day "actual"/expected working hours and the fixed monthly
// salary used by the monthly attendance Excel export to work out extra
// (overtime) hours, shortfall hours, and the payable salary.
// ─────────────────────────────────────────────────────────────────────────────
const updatePaySettings = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { standard_hours_per_day, monthly_salary } = req.body;

    const update = {};
    if (standard_hours_per_day !== undefined) {
      const hrs = Number(standard_hours_per_day);
      if (Number.isNaN(hrs) || hrs < 0 || hrs > 24) {
        return errorResponse(res, "standard_hours_per_day must be a number between 0 and 24.");
      }
      update.standard_hours_per_day = hrs;
    }
    if (monthly_salary !== undefined) {
      const sal = Number(monthly_salary);
      if (Number.isNaN(sal) || sal < 0) {
        return errorResponse(res, "monthly_salary must be a non-negative number.");
      }
      update.monthly_salary = sal;
    }
    if (!Object.keys(update).length) {
      return errorResponse(res, "Nothing to update — provide standard_hours_per_day and/or monthly_salary.");
    }

    const staff = await AdminUsersSchema.findByIdAndUpdate(staffId, update, {
      new: true,
      fields: { name: 1, email: 1, role: 1, standard_hours_per_day: 1, monthly_salary: 1 },
    });
    if (!staff) return errorResponse(res, "Staff not found.");

    return successResponse(res, "Pay settings updated.", { staff });
  } catch (err) {
    console.error("[updatePaySettings]", err);
    return errorResponse(res, "Failed to update pay settings.");
  }
};


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
// POST /session/field-work/start   body: { staffId, estimated_hours, reason }
// Marketing staff only. Starts an "out for field work" window.
// ─────────────────────────────────────────────────────────────────────────────
const startFieldWork = async (req, res) => {
  try {
    const { staffId, estimated_hours, reason } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");
    const hours = Number(estimated_hours);
    if (!hours || hours <= 0) return errorResponse(res, "Please provide a valid estimated_hours (> 0).");

    const staff = await AdminUsersSchema.findById(staffId).select("staff_category name");
    if (!staff) return errorResponse(res, "Staff not found.");
    if (staff.staff_category !== "marketing") {
      return errorResponse(res, "Field work is only available for marketing team staff.");
    }

    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active attendance session. Please do In Time first.");

    if (["active", "frozen", "resume_requested"].includes(session.field_work?.status)) {
      return errorResponse(res, "You already have an open field-work window.");
    }

    const now = new Date();
    const expected_end_at = new Date(now.getTime() + hours * 3600 * 1000);

    session.field_work = {
      status: "active",
      reason: reason?.trim() || "",
      estimated_hours: hours,
      started_at: now,
      expected_end_at,
      frozen_at: null,
      resume_requested_at: null,
      resume_reason: "",
      resumed_by: null,
      resumed_by_name: "",
      resumed_at: null,
      closed_by: null,
      closed_by_id: null,
      closed_by_name: "",
      closed_at: null,
      history: [
        { action: "started", at: now, by_name: staff.name, notes: reason?.trim() || "", estimated_hours: hours },
      ],
    };
    await session.save();

    return successResponse(res, "Field work started. Have a safe trip!", { field_work: session.field_work });
  } catch (err) {
    console.error("[startFieldWork]", err);
    return errorResponse(res, "Failed to start field work.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/field-work/finish   body: { staffId }
// Staff-initiated — "I'm back / done early", only while still "active"
// (i.e. before the estimated time has elapsed). Once frozen, only an admin
// can resume or close it — see resumeFieldWork / closeFieldWork below.
// ─────────────────────────────────────────────────────────────────────────────
const finishFieldWork = async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");

    const session = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No active field-work window found — it may have already frozen. Check your attendance status.");

    const now = new Date();
    await syncFieldWorkFreeze(session, staffId, now);

    if (session.field_work?.status !== "active") {
      return errorResponse(res, "There's no active field-work window to close. It's already frozen — request an admin resume instead.");
    }

    session.field_work.status         = "closed";
    session.field_work.closed_by      = "staff";
    session.field_work.closed_by_id   = staffId;
    session.field_work.closed_by_name = req.user?.name || "";
    session.field_work.closed_at      = now;
    session.field_work.history.push({ action: "closed_by_staff", at: now, by_name: req.user?.name || "" });
    await session.save();

    return successResponse(res, "Welcome back! Field work closed.", { field_work: session.field_work });
  } catch (err) {
    console.error("[finishFieldWork]", err);
    return errorResponse(res, "Failed to close field work.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/field-work/resume-request   body: { staffId, reason }
// Staff asks a super admin to resume a frozen field-work window. Note: by
// the time this fires the underlying attendance session has already been
// auto-logged-out (see syncFieldWorkFreeze), so we look it up via the block
// record on the staff account rather than requiring an open session.
// ─────────────────────────────────────────────────────────────────────────────
const requestFieldWorkResume = async (req, res) => {
  try {
    const { staffId, reason } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");

    const staff = await AdminUsersSchema.findById(staffId).select("attendance_blocked attendance_blocked_session_id");
    if (!staff?.attendance_blocked_session_id) {
      return errorResponse(res, "There's no frozen field-work window on file for you.");
    }

    const session = await StaffSession.findById(staff.attendance_blocked_session_id);
    if (!session) return errorResponse(res, "Couldn't find that field-work session.");

    const now = new Date();

    if (session.field_work?.status === "resume_requested") {
      return errorResponse(res, "You've already asked admin to resume — waiting for a response.");
    }
    if (session.field_work?.status !== "frozen") {
      return errorResponse(res, "Your field-work time hasn't frozen yet.");
    }

    session.field_work.status               = "resume_requested";
    session.field_work.resume_requested_at  = now;
    session.field_work.resume_reason        = reason?.trim() || "";
    session.field_work.history.push({ action: "resume_requested", at: now, by_name: req.user?.name || "", notes: reason?.trim() || "" });
    await session.save();

    return successResponse(res, "Resume request sent to admin.", { field_work: session.field_work });
  } catch (err) {
    console.error("[requestFieldWorkResume]", err);
    return errorResponse(res, "Failed to request resume.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /session/field-work/pending   (super admin only)
// Queue of staff who are frozen or have asked to be resumed. These sessions
// are usually already logged out (auto-closed on freeze), so we deliberately
// don't filter by logout_at here — only by field_work.status.
// ─────────────────────────────────────────────────────────────────────────────
const getFieldWorkQueue = async (req, res) => {
  try {
    const now = new Date();
    const sessions = await StaffSession.find({
      "field_work.status": { $in: ["active", "frozen", "resume_requested"] },
    }).populate("staff_id", "name email role profileImg staff_category");

    for (const session of sessions) {
      if (await syncFieldWorkFreeze(session, session.staff_id?._id, now)) await session.save();
    }

    const queue = sessions
      .filter((s) => ["frozen", "resume_requested"].includes(s.field_work.status))
      .map((s) => s.toObject());

    return successResponse(res, "Field work queue fetched.", queue);
  } catch (err) {
    console.error("[getFieldWorkQueue]", err);
    return errorResponse(res, "Failed to fetch field work queue.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/field-work/:staffId/resume   (super admin only)
// body: { additional_hours? }  — extends the ETA from now; omit to just
// resume with no fixed re-freeze (estimated_hours/expected_end_at cleared).
// Re-opens the auto-closed session (clears logout_at) and lifts the login
// block, so the staff member doesn't have to tap "In Time" again — their
// day just continues.
// ─────────────────────────────────────────────────────────────────────────────
const resumeFieldWork = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { additional_hours, note } = req.body;

    const staff = await AdminUsersSchema.findById(staffId).select("name attendance_blocked_session_id");
    if (!staff) return errorResponse(res, "Staff not found.");

    // Session may already be auto-logged-out (logout_at set) by the freeze —
    // look it up by id rather than requiring an open session.
    const session = staff.attendance_blocked_session_id
      ? await StaffSession.findById(staff.attendance_blocked_session_id)
      : await StaffSession.findOne({ staff_id: staffId }).sort({ login_at: -1 });
    if (!session) return errorResponse(res, "No field-work session found for this staff member.");
    if (!["frozen", "resume_requested"].includes(session.field_work?.status)) {
      return errorResponse(res, "This staff member's field work isn't frozen / awaiting resume.");
    }

    const now = new Date();
    const hours = Number(additional_hours);

    // Re-open the session — clear the auto-logout so their day continues
    // without needing a fresh In Time.
    session.logout_at        = null;
    session.duration_seconds = undefined;
    session.working_seconds  = undefined;
    session.overtime_seconds = undefined;
    session.logout_type      = undefined;

    session.field_work.status          = "active";
    session.field_work.frozen_at       = null;
    session.field_work.resumed_by      = req.user?._id || null;
    session.field_work.resumed_by_name = req.user?.name || "Super Admin";
    session.field_work.resumed_at      = now;
    session.field_work.started_at      = now;
    if (hours > 0) {
      session.field_work.estimated_hours = hours;
      session.field_work.expected_end_at = new Date(now.getTime() + hours * 3600 * 1000);
    } else {
      session.field_work.estimated_hours = null;
      session.field_work.expected_end_at = null;
    }
    session.field_work.history.push({
      action: "resumed_by_admin", at: now, by_name: req.user?.name || "Super Admin",
      notes: note?.trim() || "", estimated_hours: hours > 0 ? hours : null,
    });
    await session.save();

    await AdminUsersSchema.findByIdAndUpdate(staffId, {
      isOnline: true,
      attendance_blocked: false,
      attendance_blocked_reason: "",
      attendance_blocked_session_id: null,
    });

    return successResponse(res, "Field work resumed — staff can continue without re-logging in.", { field_work: session.field_work });
  } catch (err) {
    console.error("[resumeFieldWork]", err);
    return errorResponse(res, "Failed to resume field work.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /session/field-work/:staffId/close   (super admin only)
// Admin force-closes a frozen/resume-requested field-work window instead of
// resuming it (e.g. the staff isn't actually coming back today). This lifts
// the login block too — they can tap "In Time" fresh whenever they're back,
// they just don't get the old session reopened.
// ─────────────────────────────────────────────────────────────────────────────
const closeFieldWork = async (req, res) => {
  try {
    const { staffId } = req.params;
    const { note } = req.body;

    const staff = await AdminUsersSchema.findById(staffId).select("attendance_blocked_session_id");
    if (!staff) return errorResponse(res, "Staff not found.");

    const session = staff.attendance_blocked_session_id
      ? await StaffSession.findById(staff.attendance_blocked_session_id)
      : await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (!session) return errorResponse(res, "No field-work session found for this staff member.");
    if (!["active", "frozen", "resume_requested"].includes(session.field_work?.status)) {
      return errorResponse(res, "There's no open field-work window for this staff member.");
    }

    const now = new Date();
    if (session.field_work.status === "active") {
      closeBreakIfAny(session, now);
      finalizeSession(session, now, { logout_type: "auto_field_work_freeze" });
    }
    session.field_work.status         = "closed";
    session.field_work.closed_by      = "admin";
    session.field_work.closed_by_id   = req.user?._id || null;
    session.field_work.closed_by_name = req.user?.name || "Super Admin";
    session.field_work.closed_at      = now;
    session.field_work.history.push({ action: "closed_by_admin", at: now, by_name: req.user?.name || "Super Admin", notes: note?.trim() || "" });
    await session.save();

    await AdminUsersSchema.findByIdAndUpdate(staffId, {
      isOnline: false,
      attendance_blocked: false,
      attendance_blocked_reason: "",
      attendance_blocked_session_id: null,
    });

    return successResponse(res, "Field work closed by admin.", { field_work: session.field_work });
  } catch (err) {
    console.error("[closeFieldWork]", err);
    return errorResponse(res, "Failed to close field work.");
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

    if (!session) {
      // No open session — but if a field-work freeze auto-logged them out,
      // surface that instead of a plain "not clocked in" so the UI can show
      // the frozen/blocked state and NOT the "click In Time" button.
      const staff = await AdminUsersSchema.findById(staffId).select("attendance_blocked attendance_blocked_reason attendance_blocked_session_id");
      if (staff?.attendance_blocked) {
        const blockedSession = staff.attendance_blocked_session_id
          ? await StaffSession.findById(staff.attendance_blocked_session_id).select("field_work")
          : null;
        return successResponse(res, "Session fetched.", {
          login_at: null,
          blocked: true,
          blocked_reason: staff.attendance_blocked_reason || "",
          field_work: blockedSession?.field_work || { status: "frozen" },
          auto_logout_hour: AUTO_LOGOUT_HOUR,
          is_past_auto_logout_time: isPastAutoLogoutTime(),
        });
      }
      return errorResponse(res, "No active session found.");
    }

    if (await syncFieldWorkFreeze(session, staffId)) await session.save();

    // If it just froze (or already had), this session is now closed too —
    // report it the same "blocked" way so the caller doesn't have to guess.
    const blocked = ["frozen", "resume_requested"].includes(session.field_work?.status);

    return successResponse(res, "Session fetched.", {
      login_at:       blocked ? null : session.login_at,
      blocked,
      blocked_reason: blocked ? "Field-work estimated time elapsed. Waiting for admin to resume or close it." : "",
      active_break:   session.active_break,
      break_seconds:  session.break_seconds || 0,
      permission:     session.permission || { status: "none" },
      field_work:     session.field_work || { status: "none" },
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
    const staffList = await AdminUsersSchema.find({}, { name:1, email:1, role:1, profileImg:1, isOnline:1, available:1, staff_category:1, attendance_blocked:1, attendance_blocked_reason:1 }).lean();
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

      const fieldWorkRaw = openSession?.field_work;
      if (fieldWorkRaw && fieldWorkRaw.status === "active" && fieldWorkRaw.expected_end_at && new Date(fieldWorkRaw.expected_end_at) <= new Date()) {
        // Read-only view — reflect the frozen state without writing here;
        // the write happens lazily in getSession/getFieldWorkQueue/etc.
        fieldWorkRaw.status = "frozen";
      }
      const fieldWork = fieldWorkRaw && fieldWorkRaw.status !== "none"
        ? {
            status:           fieldWorkRaw.status,
            reason:           fieldWorkRaw.reason,
            estimated_hours:  fieldWorkRaw.estimated_hours,
            started_at:       fieldWorkRaw.started_at,
            expected_end_at:  fieldWorkRaw.expected_end_at,
            resume_reason:    fieldWorkRaw.resume_reason,
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
        fieldWork,              // current field-work window (marketing "going out"), if any
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /staff-monitor/export/attendance?month=YYYY-MM&staffId=<optional>
//
// Builds a month-wise, date-wise attendance register as an .xlsx download.
// Layout (one sheet per month):
//
//   Row 1        : "Attendance Register — <Month Year>"   (title, merged across)
//   Row 2 (hdr)  : Name | Detail | 01 (Mon) [merged 2 cols] | ... | Standard Hrs | Total Worked | Total Break | Extra Hrs | Shortfall Hrs | Adjusted Hrs | Payable Salary
//   Row 3 (hdr)  :      |        | In     | Out             | ... |
//   Per staff (4 data rows — Name + every summary column merged down across all 4):
//     Row A (In/Out)  :      | In / Out | 9:00 AM | 6:00 PM  | ... |
//     Row B (Break)   :      | Break    | 30m [merged 2 cols]      | ... |
//     Row C (Working) :      | Working  | 7h 30m [merged 2 cols]   | ... |
//     Row D (Extra)   :      | Extra    | +1h 00m [merged 2 cols]  | ... |
//
// Extra/shortfall hours per day are worked out against that staff member's
// own "standard_hours_per_day" setting (super admin sets this per staff).
// If the month's Total Working Hours falls short of the Standard Hours
// target, the Extra hours banked on other days are applied to make up the
// difference — the result is "Adjusted Hrs". Payable Salary is the staff's
// monthly_salary prorated by (Adjusted Hrs / Standard Hrs).
// ─────────────────────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");

const fmtClockTime = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  let h = dt.getHours();
  const m = dt.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${pad2(m)} ${ampm}`;
};

// Same as fmtClockTime, but prefixes the date (e.g. "Jul 1, 9:00 AM").
// Used when a session's working hours run past 24h, so the sheet doesn't
// silently show a bare time that could belong to a different calendar day.
const fmtDateTime = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  const datePart = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${datePart}, ${fmtClockTime(dt)}`;
};

const DAY_SECONDS = 24 * 3600;

// Picks fmtDateTime when the day's total working seconds exceed 24h
// (overnight / multi-day sessions), otherwise the plain time-only format.
const fmtInOutTime = (d, workSecs) => (workSecs > DAY_SECONDS ? fmtDateTime(d) : fmtClockTime(d));

const secsToHoursMinutes = (total) => {
  const s = Math.max(0, Math.floor(total || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad2(m)}m`;
};

const fmtCurrency = (amount) =>
  `₹${Number(amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const HEADER_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
const WEEKEND_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
const TOTAL_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } };
const HOURS_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };
const BREAK_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF2F2" } };
const EXTRA_FILL    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
const SALARY_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF4E7" } };
const THIN_BORDER   = { style: "thin", color: { argb: "FFE5E7EB" } };
const CELL_BORDER   = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

// staffId -> dateStr -> { firstIn, lastOut, breakSecs, workSecs } for sessions in [startDateStr, endDateStr]
const buildAttendanceGrid = async (staffIds, startDateStr, endDateStr) => {
  const sessions = await StaffSession.find({
    staff_id: { $in: staffIds },
    date: { $gte: startDateStr, $lte: endDateStr },
  }).sort({ login_at: 1 }).lean();

  const grid = {};
  for (const s of sessions) {
    const sid = s.staff_id.toString();
    if (!grid[sid]) grid[sid] = {};
    const d = s.date;
    if (!grid[sid][d]) grid[sid][d] = { firstIn: s.login_at, lastOut: s.logout_at || null, breakSecs: 0 };
    const cell = grid[sid][d];

    if (new Date(s.login_at) < new Date(cell.firstIn)) cell.firstIn = s.login_at;
    if (s.logout_at && (!cell.lastOut || new Date(s.logout_at) > new Date(cell.lastOut))) {
      cell.lastOut = s.logout_at;
    }
    cell.breakSecs += (s.break_seconds || 0);
  }

  // Working hours are computed directly from each day's first-In to last-Out
  // span (minus any recorded breaks) — not from the session's stored
  // `working_seconds` field — so the exported "Working" row always matches
  // exactly what the In/Out columns show, even after an admin edits a
  // session's login/logout time.
  for (const sid of Object.keys(grid)) {
    for (const d of Object.keys(grid[sid])) {
      const cell = grid[sid][d];
      const endMs = cell.lastOut ? new Date(cell.lastOut).getTime() : Date.now();
      const spanSecs = Math.max(0, Math.floor((endMs - new Date(cell.firstIn).getTime()) / 1000));
      cell.workSecs = Math.max(0, spanSecs - (cell.breakSecs || 0));
    }
  }
  return grid;
};

const exportMonthlyAttendance = async (req, res) => {
  try {
    const monthParam = req.query.month || todayStr().slice(0, 7); // "YYYY-MM"
    if (!/^\d{4}-\d{2}$/.test(monthParam)) {
      return errorResponse(res, "Invalid month. Use format YYYY-MM, e.g. 2026-07.");
    }
    const [yearStr, monStr] = monthParam.split("-");
    const year  = Number(yearStr);
    const month = Number(monStr); // 1-12
    const daysInMonth = new Date(year, month, 0).getDate();

    // Sundays are treated as holidays — they don't count toward the month's
    // required (standard) hours target. Every other day of the month does,
    // whether or not the staff member actually showed up.
    let sundayCount = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      if (new Date(year, month - 1, day).getDay() === 0) sundayCount += 1;
    }
    const workingDaysInMonth = daysInMonth - sundayCount;

    const staffFilter = {};
    if (req.query.staffId) staffFilter._id = req.query.staffId;

    const staffList = await AdminUsersSchema.find(staffFilter, {
      name: 1, email: 1, role: 1, standard_hours_per_day: 1, monthly_salary: 1,
    }).sort({ name: 1 }).lean();
    if (!staffList.length) return errorResponse(res, "No staff found for the given filter.");

    const staffIds = staffList.map((s) => s._id);
    const startDateStr = `${monthParam}-01`;
    const endDateStr   = `${monthParam}-${pad2(daysInMonth)}`;
    const grid = await buildAttendanceGrid(staffIds, startDateStr, endDateStr);

    // ── Build workbook ──────────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Job Sheet App";
    workbook.created = new Date();

    const monthLabel = new Date(year, month - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
    const sheet = workbook.addWorksheet(monthLabel.replace(/[\\/*?:[\]]/g, ""));

    const NAME_COL       = 1;
    const METRIC_COL     = 2;
    const FIRST_DATE_COL = 3; // each date occupies 2 columns: In / Out
    const SUMMARY_START  = FIRST_DATE_COL + daysInMonth * 2;
    const COL_STANDARD   = SUMMARY_START;
    const COL_WORKED     = SUMMARY_START + 1;
    const COL_BREAK      = SUMMARY_START + 2;
    const COL_EXTRA      = SUMMARY_START + 3;
    const COL_SHORTFALL  = SUMMARY_START + 4;
    const COL_ADJUSTED   = SUMMARY_START + 5;
    const COL_REMAINING_EXTRA = SUMMARY_START + 6;
    const COL_SALARY     = SUMMARY_START + 7;
    const LAST_COL       = COL_SALARY;

    // Title row
    sheet.mergeCells(1, 1, 1, LAST_COL);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = `Attendance Register — ${monthLabel}  (Sundays are holidays · ${workingDaysInMonth} working days)`;
    titleCell.font = { bold: true, size: 13 };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 26;

    const HEADER_ROW_1   = 2;
    const HEADER_ROW_2   = 3;
    const DATA_START_ROW = 4;
    const ROWS_PER_STAFF = 4; // Row A = In/Out, Row B = Break, Row C = Working, Row D = Extra

    // Name / Detail column headers (merged down across both header rows)
    sheet.mergeCells(HEADER_ROW_1, NAME_COL, HEADER_ROW_2, NAME_COL);
    sheet.getCell(HEADER_ROW_1, NAME_COL).value = "Name";
    sheet.mergeCells(HEADER_ROW_1, METRIC_COL, HEADER_ROW_2, METRIC_COL);
    sheet.getCell(HEADER_ROW_1, METRIC_COL).value = "Detail";

    // Summary column headers (merged down across both header rows)
    const summaryHeaders = [
      [COL_STANDARD,  "Standard Hrs"],
      [COL_WORKED,    "Total Worked"],
      [COL_BREAK,     "Total Break"],
      [COL_EXTRA,     "Extra Hrs"],
      [COL_SHORTFALL, "Shortfall Hrs"],
      [COL_ADJUSTED,  "Adjusted Hrs"],
      [COL_REMAINING_EXTRA, "Remaining Extra Hrs"],
      [COL_SALARY,    "Payable Salary"],
    ];
    summaryHeaders.forEach(([col, label]) => {
      sheet.mergeCells(HEADER_ROW_1, col, HEADER_ROW_2, col);
      sheet.getCell(HEADER_ROW_1, col).value = label;
    });

    const sundayCols = new Set();

    // Per-date headers + In/Out sub-headers
    for (let day = 1; day <= daysInMonth; day++) {
      const col = FIRST_DATE_COL + (day - 1) * 2;
      const dateObj = new Date(year, month - 1, day);
      const weekday = dateObj.toLocaleDateString("en-US", { weekday: "short" });
      const isSunday = dateObj.getDay() === 0;
      if (isSunday) { sundayCols.add(col); sundayCols.add(col + 1); }

      sheet.mergeCells(HEADER_ROW_1, col, HEADER_ROW_1, col + 1);
      sheet.getCell(HEADER_ROW_1, col).value = isSunday ? `${pad2(day)} (Sun · Holiday)` : `${pad2(day)} (${weekday})`;
      sheet.getCell(HEADER_ROW_2, col).value = "In";
      sheet.getCell(HEADER_ROW_2, col + 1).value = "Out";
    }

    // Style header rows
    [HEADER_ROW_1, HEADER_ROW_2].forEach((r) => {
      sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: true, size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        cell.fill = HEADER_FILL;
        cell.border = CELL_BORDER;
      });
    });

    // Data — 4 rows per staff member: In/Out, Break, Working, Extra
    staffList.forEach((staff, idx) => {
      const rowIn    = DATA_START_ROW + idx * ROWS_PER_STAFF;
      const rowBreak = rowIn + 1;
      const rowWork  = rowIn + 2;
      const rowExtra = rowIn + 3;
      const sid = staff._id.toString();
      const staffGrid = grid[sid] || {};
      const standardSecsPerDay = (Number(staff.standard_hours_per_day) || 10) * 3600;

      // Name merged vertically across this staff's 4 rows
      sheet.mergeCells(rowIn, NAME_COL, rowExtra, NAME_COL);
      const nameCell = sheet.getCell(rowIn, NAME_COL);
      nameCell.value = staff.name;
      nameCell.font = { bold: true, size: 10 };
      nameCell.alignment = { vertical: "middle" };

      // Row-metric labels (one per row, not merged)
      const metricLabels = { [rowIn]: "In / Out", [rowBreak]: "Break", [rowWork]: "Working", [rowExtra]: "Extra" };
      [rowIn, rowBreak, rowWork, rowExtra].forEach((r) => {
        const c = sheet.getCell(r, METRIC_COL);
        c.value = metricLabels[r];
        c.font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
        c.alignment = { vertical: "middle" };
      });

      let totalWorkSecs = 0, totalBreakSecs = 0, totalExtraSecs = 0, totalShortfallSecs = 0;

      for (let day = 1; day <= daysInMonth; day++) {
        const col = FIRST_DATE_COL + (day - 1) * 2;
        const dateStr = `${monthParam}-${pad2(day)}`;
        const cellData = staffGrid[dateStr];
        const isSunday = sundayCols.has(col);

        const inCell  = sheet.getCell(rowIn, col);
        const outCell = sheet.getCell(rowIn, col + 1);

        sheet.mergeCells(rowBreak, col, rowBreak, col + 1);
        sheet.mergeCells(rowWork,  col, rowWork,  col + 1);
        sheet.mergeCells(rowExtra, col, rowExtra, col + 1);
        const breakCell = sheet.getCell(rowBreak, col);
        const workCell  = sheet.getCell(rowWork,  col);
        const extraCell = sheet.getCell(rowExtra, col);

        if (isSunday) {
          // Holiday — no hours are owed. Anything worked counts entirely as
          // bonus extra; nothing is ever counted as shortfall.
          if (cellData && cellData.lastOut) {
            inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
            outCell.value = fmtInOutTime(cellData.lastOut, cellData.workSecs);
            breakCell.value = secsToHoursMinutes(cellData.breakSecs);
            workCell.value  = secsToHoursMinutes(cellData.workSecs);
            extraCell.value = `+${secsToHoursMinutes(cellData.workSecs)} (Holiday)`;
            totalWorkSecs  += cellData.workSecs;
            totalBreakSecs += cellData.breakSecs;
            totalExtraSecs += cellData.workSecs;
          } else if (cellData) {
            inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
            outCell.value = "—";
            breakCell.value = workCell.value = extraCell.value = "—";
          } else {
            inCell.value = "Holiday";
            outCell.value = "";
            breakCell.value = workCell.value = extraCell.value = "—";
          }
        } else if (cellData) {
          inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
          outCell.value = cellData.lastOut ? fmtInOutTime(cellData.lastOut, cellData.workSecs) : "—";

          if (cellData.lastOut) {
            const dayExtraSecs = Math.max(0, cellData.workSecs - standardSecsPerDay);
            const dayShortSecs = Math.max(0, standardSecsPerDay - cellData.workSecs);

            breakCell.value = secsToHoursMinutes(cellData.breakSecs);
            workCell.value  = secsToHoursMinutes(cellData.workSecs);
            extraCell.value = dayExtraSecs > 0 ? `+${secsToHoursMinutes(dayExtraSecs)}` : "—";

            totalWorkSecs      += cellData.workSecs;
            totalBreakSecs      += cellData.breakSecs;
            totalExtraSecs      += dayExtraSecs;
            totalShortfallSecs  += dayShortSecs;
          } else {
            // Still an open/ongoing session — can't finalize the day's hours yet.
            breakCell.value = "—";
            workCell.value  = "—";
            extraCell.value = "—";
          }
        } else {
          // Absent on a required working day — the full day counts as shortfall.
          inCell.value  = "Absent";
          outCell.value = "";
          breakCell.value = "—";
          workCell.value  = "—";
          extraCell.value = "—";
          totalShortfallSecs += standardSecsPerDay;
        }

        inCell.alignment  = { horizontal: "center" };
        outCell.alignment = { horizontal: "center" };
        inCell.font  = cellData ? { size: 9.5 } : { size: 9.5, italic: true, color: { argb: "FF9CA3AF" } };
        outCell.font = { size: 9.5 };

        breakCell.alignment = { horizontal: "center", vertical: "middle" };
        breakCell.font  = { size: 9, color: { argb: "FFB91C1C" } };
        breakCell.fill  = BREAK_FILL;

        workCell.alignment = { horizontal: "center", vertical: "middle" };
        workCell.font  = { size: 9.5, italic: true, color: { argb: "FF15803D" } };
        workCell.fill  = HOURS_FILL;

        extraCell.alignment = { horizontal: "center", vertical: "middle" };
        extraCell.font  = { size: 9, color: { argb: "FF1D4ED8" } };
        extraCell.fill  = EXTRA_FILL;

        if (isSunday) { inCell.fill = WEEKEND_FILL; outCell.fill = WEEKEND_FILL; }
      }

      // ── Monthly summary for this staff ──────────────────────────────────
      // Standard target is calendar-based (working days × standard hrs/day),
      // not based on how many days the staff actually showed up — an absent
      // required day is already folded into totalShortfallSecs above.
      const standardMonthlySecs = workingDaysInMonth * standardSecsPerDay;
      // If the month fell short overall, apply the banked Extra hours toward
      // the shortfall — capped so "Adjusted" never overshoots the target.
      const adjustedSecs = totalWorkSecs >= standardMonthlySecs
        ? totalWorkSecs
        : Math.min(standardMonthlySecs, totalWorkSecs + totalExtraSecs);
      // Extra hours left over after covering whatever shortfall existed.
      const remainingExtraSecs = Math.max(0, totalExtraSecs - totalShortfallSecs);
      const hasSalary = Number(staff.monthly_salary) > 0 && standardMonthlySecs > 0;
      const payableSalary = hasSalary
        ? Number(staff.monthly_salary) * (adjustedSecs / standardMonthlySecs)
        : null;

      const summaryValues = [
        [COL_STANDARD,  secsToHoursMinutes(standardMonthlySecs)],
        [COL_WORKED,    secsToHoursMinutes(totalWorkSecs)],
        [COL_BREAK,     secsToHoursMinutes(totalBreakSecs)],
        [COL_EXTRA,     secsToHoursMinutes(totalExtraSecs)],
        [COL_SHORTFALL, secsToHoursMinutes(totalShortfallSecs)],
        [COL_ADJUSTED,  secsToHoursMinutes(adjustedSecs)],
        [COL_REMAINING_EXTRA, secsToHoursMinutes(remainingExtraSecs)],
        [COL_SALARY,    payableSalary !== null ? fmtCurrency(payableSalary) : "—"],
      ];
      summaryValues.forEach(([col, value]) => {
        sheet.mergeCells(rowIn, col, rowExtra, col);
        const cell = sheet.getCell(rowIn, col);
        cell.value = value;
        cell.font = { bold: true, size: 10 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = col === COL_SALARY ? SALARY_FILL : TOTAL_FILL;
      });

      [rowIn, rowBreak, rowWork, rowExtra].forEach((r) => {
        sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => { cell.border = CELL_BORDER; });
      });
    });

    // Column widths
    sheet.getColumn(NAME_COL).width   = 22;
    sheet.getColumn(METRIC_COL).width = 10;
    for (let day = 1; day <= daysInMonth; day++) {
      const col = FIRST_DATE_COL + (day - 1) * 2;
      sheet.getColumn(col).width = 11;
      sheet.getColumn(col + 1).width = 11;
    }
    [COL_STANDARD, COL_WORKED, COL_BREAK, COL_EXTRA, COL_SHORTFALL, COL_ADJUSTED, COL_REMAINING_EXTRA].forEach((col) => {
      sheet.getColumn(col).width = 14;
    });
    sheet.getColumn(COL_SALARY).width = 18;

    sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];

    const fileName = `Attendance_${monthLabel.replace(/\s+/g, "_")}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error("[exportMonthlyAttendance]", err);
    return errorResponse(res, "Failed to export attendance.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /staff-monitor/export/attendance/daily?date=YYYY-MM-DD&staffId=<optional>
//
// Builds a single day's attendance sheet as an .xlsx download, using the same
// pattern as the monthly register: each staff member gets 4 rows —
//   Row A (In/Out)  : Name | In Time | Out Time
//   Row B (Break)   :      | Break time    [merged across In/Out columns]
//   Row C (Working) :      | Working hours [merged across In/Out columns]
//   Row D (Extra)   :      | Extra hours beyond that staff's standard hours/day
// (Name is merged vertically down across all 4 of that staff's rows.)
// ─────────────────────────────────────────────────────────────────────────────
const exportDailyAttendance = async (req, res) => {
  try {
    const dateParam = req.query.date || todayStr(); // "YYYY-MM-DD"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return errorResponse(res, "Invalid date. Use format YYYY-MM-DD, e.g. 2026-07-31.");
    }

    const staffFilter = {};
    if (req.query.staffId) staffFilter._id = req.query.staffId;

    const staffList = await AdminUsersSchema.find(staffFilter, {
      name: 1, email: 1, role: 1, standard_hours_per_day: 1,
    }).sort({ name: 1 }).lean();
    if (!staffList.length) return errorResponse(res, "No staff found for the given filter.");

    const staffIds = staffList.map((s) => s._id);
    const grid = await buildAttendanceGrid(staffIds, dateParam, dateParam);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Job Sheet App";
    workbook.created = new Date();

    const dateObj = new Date(`${dateParam}T00:00:00`);
    const dateLabel = dateObj.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const isSunday = dateObj.getDay() === 0;
    const sheet = workbook.addWorksheet(dateParam);

    const NAME_COL   = 1;
    const METRIC_COL = 2;
    const IN_COL     = 3;
    const OUT_COL    = 4;

    // Title row
    sheet.mergeCells(1, 1, 1, 4);
    const titleCell = sheet.getCell(1, 1);
    titleCell.value = isSunday ? `Daily Attendance — ${dateLabel} (Sunday · Holiday)` : `Daily Attendance — ${dateLabel}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 26;

    // Single header row — the date itself is only ever "one column pair", so
    // (unlike the monthly sheet) there's no separate date row above it.
    const HEADER_ROW = 2;
    sheet.getCell(HEADER_ROW, NAME_COL).value   = "Name";
    sheet.getCell(HEADER_ROW, METRIC_COL).value = "Detail";
    sheet.getCell(HEADER_ROW, IN_COL).value     = "In Time";
    sheet.getCell(HEADER_ROW, OUT_COL).value    = "Out Time";
    sheet.getRow(HEADER_ROW).eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, size: 11 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.fill = HEADER_FILL;
      cell.border = CELL_BORDER;
    });

    const DATA_START_ROW = 3;
    const ROWS_PER_STAFF = 4; // Row A = In/Out, Row B = Break, Row C = Working, Row D = Extra

    staffList.forEach((staff, idx) => {
      const rowIn    = DATA_START_ROW + idx * ROWS_PER_STAFF;
      const rowBreak = rowIn + 1;
      const rowWork  = rowIn + 2;
      const rowExtra = rowIn + 3;
      const sid = staff._id.toString();
      const cellData = (grid[sid] || {})[dateParam];
      const standardSecsPerDay = (Number(staff.standard_hours_per_day) || 10) * 3600;

      // Name merged vertically across this staff's 4 rows
      sheet.mergeCells(rowIn, NAME_COL, rowExtra, NAME_COL);
      const nameCell = sheet.getCell(rowIn, NAME_COL);
      nameCell.value = staff.name;
      nameCell.font = { bold: true, size: 10.5 };
      nameCell.alignment = { vertical: "middle" };

      const metricLabels = { [rowIn]: "In / Out", [rowBreak]: "Break", [rowWork]: "Working", [rowExtra]: "Extra" };
      [rowIn, rowBreak, rowWork, rowExtra].forEach((r) => {
        const c = sheet.getCell(r, METRIC_COL);
        c.value = metricLabels[r];
        c.font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
        c.alignment = { vertical: "middle" };
      });

      const inCell  = sheet.getCell(rowIn, IN_COL);
      const outCell = sheet.getCell(rowIn, OUT_COL);

      sheet.mergeCells(rowBreak, IN_COL, rowBreak, OUT_COL);
      sheet.mergeCells(rowWork,  IN_COL, rowWork,  OUT_COL);
      sheet.mergeCells(rowExtra, IN_COL, rowExtra, OUT_COL);
      const breakCell = sheet.getCell(rowBreak, IN_COL);
      const workCell  = sheet.getCell(rowWork,  IN_COL);
      const extraCell = sheet.getCell(rowExtra, IN_COL);

      if (isSunday) {
        // Holiday — anything worked is entirely bonus; nothing is shortfall.
        if (cellData && cellData.lastOut) {
          inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
          outCell.value = fmtInOutTime(cellData.lastOut, cellData.workSecs);
          inCell.font  = { size: 10.5 };
          outCell.font = { size: 10.5 };
          breakCell.value = secsToHoursMinutes(cellData.breakSecs);
          workCell.value  = secsToHoursMinutes(cellData.workSecs);
          extraCell.value = `+${secsToHoursMinutes(cellData.workSecs)} (Holiday)`;
        } else if (cellData) {
          inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
          outCell.value = "—";
          inCell.font  = { size: 10.5 };
          outCell.font = { size: 10.5 };
          breakCell.value = workCell.value = extraCell.value = "—";
        } else {
          inCell.value  = "Holiday";
          outCell.value = "";
          inCell.font  = { size: 10.5, italic: true, color: { argb: "FF9CA3AF" } };
          outCell.font = { size: 10.5 };
          breakCell.value = workCell.value = extraCell.value = "—";
        }
      } else if (cellData) {
        inCell.value  = fmtInOutTime(cellData.firstIn, cellData.workSecs);
        outCell.value = cellData.lastOut ? fmtInOutTime(cellData.lastOut, cellData.workSecs) : "—";
        inCell.font  = { size: 10.5 };
        outCell.font = { size: 10.5 };

        if (cellData.lastOut) {
          const dayExtraSecs = Math.max(0, cellData.workSecs - standardSecsPerDay);
          breakCell.value = secsToHoursMinutes(cellData.breakSecs);
          workCell.value  = secsToHoursMinutes(cellData.workSecs);
          extraCell.value = dayExtraSecs > 0 ? `+${secsToHoursMinutes(dayExtraSecs)}` : "—";
        } else {
          breakCell.value = workCell.value = extraCell.value = "—";
        }
      } else {
        inCell.value    = "Absent";
        outCell.value   = "";
        inCell.font  = { size: 10.5, italic: true, color: { argb: "FF9CA3AF" } };
        outCell.font = { size: 10.5 };
        breakCell.value = workCell.value = extraCell.value = "—";
      }

      inCell.alignment  = { horizontal: "center", vertical: "middle" };
      outCell.alignment = { horizontal: "center", vertical: "middle" };

      breakCell.alignment = { horizontal: "center", vertical: "middle" };
      breakCell.font = { size: 10, color: { argb: "FFB91C1C" } };
      breakCell.fill = BREAK_FILL;

      workCell.alignment = { horizontal: "center", vertical: "middle" };
      workCell.font = { size: 10.5, bold: true, color: { argb: "FF15803D" } };
      workCell.fill = HOURS_FILL;

      extraCell.alignment = { horizontal: "center", vertical: "middle" };
      extraCell.font = { size: 10, color: { argb: "FF1D4ED8" } };
      extraCell.fill = EXTRA_FILL;

      [rowIn, rowBreak, rowWork, rowExtra].forEach((r) => {
        sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => { cell.border = CELL_BORDER; });
      });
    });

    sheet.getColumn(NAME_COL).width   = 22;
    sheet.getColumn(METRIC_COL).width = 10;
    sheet.getColumn(IN_COL).width     = 16;
    sheet.getColumn(OUT_COL).width    = 16;
    sheet.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];

    const fileName = `Attendance_${dateParam}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error("[exportDailyAttendance]", err);
    return errorResponse(res, "Failed to export daily attendance.");
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
  // Manual login/logout time correction (super admin)
  editSessionTime,
  // Manually add a brand-new attendance entry (super admin)
  createManualSession,
  // Pay & hours settings (super admin)
  updatePaySettings,
  // Field work (marketing "going out" with ETA)
  startFieldWork, finishFieldWork, requestFieldWorkResume,
  resumeFieldWork, closeFieldWork, getFieldWorkQueue,
  // Attendance export
  exportMonthlyAttendance, exportDailyAttendance,
};