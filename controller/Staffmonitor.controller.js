/**
 * staffMonitor.controller.js  (enhanced with break / lunch / OT)
 *
 * Routes (mount under /api/staff-monitor):
 *
 *   POST   /session/login              recordLogin
 *   POST   /session/logout             recordLogout
 *   POST   /session/break/start        startBreak
 *   POST   /session/break/end          endBreak
 *   GET    /monitor                    getMonitorList
 *   GET    /monitor/:id/details        getStaffDetails
 *   GET    /monitor/:id/job-time       getStaffJobTime
 *   POST   /task-log                   submitTaskLog
 *   DELETE /task-log/:logId            deleteTaskLog
 *
 * OT RULE: Standard working day = 8 h (28 800 s).
 *   OT = max(0, working_seconds - 28800)  calculated on logout.
 *   working_seconds = session_duration - total_break_seconds
 */

const axios = require("axios");
const AdminUsersSchema = require("../modals/adminusers.modals");
const { StaffSession, StaffTaskLog } = require("../modals/Staffmonitor.model");
const Job = require("../modals/job.modal");
const SiteVisit = require("../modals/visit.modal");
const MaterialIssue = require("../modals/Material_issue.model");
const { successResponse, errorResponse } = require("../helper/response.helper");

const STANDARD_WORK_SECONDS = 8 * 3600; // 28 800

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
    // Close ghost session
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (openSession) {
      openSession.logout_at = now;
      openSession.duration_seconds = Math.max(0, Math.floor((now - openSession.login_at) / 1000));
      openSession.working_seconds  = Math.max(0, openSession.duration_seconds - (openSession.break_seconds || 0));
      openSession.overtime_seconds = Math.max(0, openSession.working_seconds - STANDARD_WORK_SECONDS);
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
      // End any active break first
      if (openSession.active_break?.start) {
        const bSecs = Math.max(0, Math.floor((now - openSession.active_break.start) / 1000));
        const lastBreak = openSession.breaks[openSession.breaks.length - 1];
        if (lastBreak && !lastBreak.end) {
          lastBreak.end = now;
          lastBreak.duration_seconds = bSecs;
        }
        openSession.break_seconds = (openSession.break_seconds || 0) + bSecs;
        openSession.active_break  = { type: null, start: null };
      }
      openSession.logout_at        = now;
      openSession.duration_seconds = Math.max(0, Math.floor((now - openSession.login_at) / 1000));
      openSession.working_seconds  = Math.max(0, openSession.duration_seconds - (openSession.break_seconds || 0));
      openSession.overtime_seconds = Math.max(0, openSession.working_seconds - STANDARD_WORK_SECONDS);
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
 
    const session = await StaffSession.findOne({
      staff_id: staffId,
      logout_at: null,
    });
 
    if (!session) return errorResponse(res, "No active session found.");
 
    return successResponse(res, "Session fetched.", {
      login_at:      session.login_at,
      active_break:  session.active_break,   // { type, start } or { type: null, start: null }
      break_seconds: session.break_seconds || 0,
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

      const todaySeconds = sessions.reduce((acc, s) => {
        if (s.logout_at) return acc + (s.duration_seconds || 0);
        return acc + Math.floor((Date.now() - new Date(s.login_at).getTime()) / 1000);
      }, 0);

      // Break / OT summary for today
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
        jobStats: {
          activeJobs:           js.activeJobs ?? 0,
          totalJobSecondsToday: js.totalJobSecondsToday ?? 0,
          totalJobSecondsAll:   js.totalJobSecondsAll ?? 0,
          totalJobDisplayToday: secsToDisplay(js.totalJobSecondsToday ?? 0),
          totalJobDisplayAll:   secsToDisplay(js.totalJobSecondsAll ?? 0),
          jobsAssignedTotal:    js.jobsAssignedTotal ?? 0,
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

    // Aggregate OT across all sessions
    const totalBreakSeconds    = sessions.reduce((a, s) => a + (s.break_seconds || 0), 0);
    const totalWorkingSeconds  = sessions.reduce((a, s) => a + (s.working_seconds || 0), 0);
    const totalOvertimeSeconds = sessions.reduce((a, s) => a + (s.overtime_seconds || 0), 0);

    // ── Site Visits ───────────────────────────────────────────────────────────
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

    // ── Material Issues ────────────────────────────────────────────────────────
    const issuedMaterials = await MaterialIssue.find({ "issued_to.user_id": id })
      .select("issue_no job_no cart_item_name status issued_qty material return pickup_assignment outsource_vendor")
      .sort({ createdAt: -1 })
      .lean()
      .catch(() => []);

    // Separate pickups by this staff member
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

module.exports = { recordLogin, recordLogout, startBreak, endBreak, getMonitorList, getStaffDetails, getStaffJobTime, submitTaskLog, deleteTaskLog, getSession };