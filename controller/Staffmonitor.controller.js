/**
 * staffMonitor.controller.js
 *
 * Routes (mount under /api/staff-monitor):
 *
 *   POST   /session/login              recordLogin
 *   POST   /session/logout             recordLogout
 *   GET    /monitor                    getMonitorList
 *   GET    /monitor/:id/details        getStaffDetails
 *   GET    /monitor/:id/job-time       getStaffJobTime
 *   POST   /task-log                   submitTaskLog
 *   DELETE /task-log/:logId            deleteTaskLog
 *
 * KEY BEHAVIOURS:
 *   - recordLogin: saves selfie_url + location (lat/lng/accuracy).
 *                  Reverse-geocodes coordinates into a human-readable
 *                  formatted_address + place_name using the free
 *                  Nominatim API (no key required).
 *                  Falls back gracefully when geocoding fails or coords
 *                  are absent.
 *   - getMonitorList: returns latestSelfie { selfie_url, location, login_at }
 *                     per staff member, with location.formatted_address
 *                     ready for the frontend to display directly.
 *   - getStaffDetails: every session object now carries selfie_url + full
 *                      location sub-document.
 */

const axios                          = require("axios");
const AdminUsersSchema               = require("../modals/adminusers.modals");
const { StaffSession, StaffTaskLog } = require("../modals/Staffmonitor.model");
const Job                            = require("../modals/job.modal");
const { successResponse, errorResponse } = require("../helper/response.helper");

// ─── Roles that are permitted to skip the selfie ──────────────────────────────
const BYPASS_ROLES = ["super_admin", "super admin", "admin"];

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);

const secsToDisplay = (total) => {
  const s   = Math.max(0, Math.floor(total));
  const h   = String(Math.floor(s / 3600)).padStart(2, "0");
  const m   = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

/**
 * reverseGeocode
 * Calls the Nominatim reverse-geocoding API (free, no key required).
 * Returns { formatted_address, place_name } or empty strings on failure.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{ formatted_address: string, place_name: string }>}
 */
const reverseGeocode = async (lat, lng) => {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`;
    const { data } = await axios.get(url, {
      timeout: 6000,
      headers: {
        // Nominatim requires a descriptive User-Agent to avoid rate-limiting
        "User-Agent": "JobSheetApp/1.0 (staff-attendance-monitor)",
        "Accept-Language": "en",
      },
    });

    const addr    = data?.address || {};
    const display = data?.display_name || "";

    // Build a shorter, friendlier address: "Road, Area, City, State"
    const parts = [
      addr.road || addr.pedestrian || addr.footway || "",
      addr.suburb || addr.neighbourhood || addr.quarter || "",
      addr.city || addr.town || addr.village || addr.hamlet || "",
      addr.state || "",
    ].filter(Boolean);

    const formatted_address = parts.length ? parts.join(", ") : display;

    // place_name: the smallest-named locality
    const place_name =
      addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || "";

    return { formatted_address, place_name };
  } catch (err) {
    console.warn("[reverseGeocode] Failed:", err?.message);
    return { formatted_address: "", place_name: "" };
  }
};

/**
 * extractUserWorkFromStages
 * Returns per-stage work breakdown + total seconds for a given user.
 */
const extractUserWorkFromStages = (stages = [], userId) => {
  const result = [];
  let totalSeconds = 0;

  for (const stage of stages) {
    const isHandler = stage.handled_by?.user_id?.toString() === userId;
    if (!isHandler) continue;

    const userSessions = (stage.work_sessions || []).filter(
      (s) => !s.user_id || s.user_id?.toString() === userId,
    );

    let stageSecs  = 0;
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
//
// Body: { staffId, selfie_url?, latitude?, longitude?, accuracy? }
//
// Behaviour:
//   • All roles: selfie expected — controller accepts whatever the frontend
//     sends (selfie enforcement lives in the UI).
//   • Reverse-geocodes lat/lng when present and stores formatted_address +
//     place_name on the location sub-document.
//   • Closes any ghost open session before creating the new one.
// ─────────────────────────────────────────────────────────────────────────────
const recordLogin = async (req, res) => {
  try {
    const { staffId, selfie_url, latitude, longitude, accuracy } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");

    const staff = await AdminUsersSchema.findById(staffId)
      .select("name role isOnline")
      .lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const now = new Date();

    // ── Close any ghost open session ─────────────────────────────────────────
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });
    if (openSession) {
      openSession.logout_at        = now;
      openSession.duration_seconds = Math.max(
        0,
        Math.floor((now - openSession.login_at) / 1000),
      );
      await openSession.save();
    }

    // ── Resolve location ─────────────────────────────────────────────────────
    const hasCoords = latitude != null && longitude != null;
    let locationData = {
      latitude:          null,
      longitude:         null,
      accuracy:          null,
      formatted_address: "",
      place_name:        "",
    };

    if (hasCoords) {
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);

      // Reverse-geocode to get a human-readable address
      const { formatted_address, place_name } = await reverseGeocode(lat, lng);

      locationData = {
        latitude:          lat,
        longitude:         lng,
        accuracy:          accuracy != null ? parseFloat(accuracy) : null,
        formatted_address: formatted_address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        place_name,
      };
    }

    // ── Create session ───────────────────────────────────────────────────────
    const session = await StaffSession.create({
      staff_id:   staffId,
      login_at:   now,
      date:       todayStr(),
      login_ip:   req.ip || req.headers["x-forwarded-for"] || "",
      selfie_url: selfie_url || "",
      location:   locationData,
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
// Body: { staffId }
// ─────────────────────────────────────────────────────────────────────────────
const recordLogout = async (req, res) => {
  try {
    const { staffId } = req.body;
    if (!staffId) return errorResponse(res, "staffId is required.");

    const now         = new Date();
    const openSession = await StaffSession.findOne({ staff_id: staffId, logout_at: null });

    if (openSession) {
      openSession.logout_at        = now;
      openSession.duration_seconds = Math.max(
        0,
        Math.floor((now - openSession.login_at) / 1000),
      );
      await openSession.save();
    }

    await AdminUsersSchema.findByIdAndUpdate(staffId, { isOnline: false });

    return successResponse(res, "Logout recorded.");
  } catch (err) {
    console.error("[recordLogout]", err);
    return errorResponse(res, "Failed to record logout.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /monitor
//
// Returns one entry per staff member with:
//   latestSelfie: {
//     selfie_url,
//     location: { latitude, longitude, accuracy, formatted_address, place_name },
//     login_at
//   } | null
// ─────────────────────────────────────────────────────────────────────────────
const getMonitorList = async (req, res) => {
  try {
    const today = todayStr();

    const staffList = await AdminUsersSchema.find(
      {},
      { name: 1, email: 1, role: 1, profileImg: 1, isOnline: 1, available: 1 },
    ).lean();

    const staffIds    = staffList.map((s) => s._id);
    const staffIdStrs = staffIds.map((id) => id.toString());

    // ── Login sessions for today ──────────────────────────────────────────
    const todaySessions = await StaffSession.find({
      staff_id: { $in: staffIds },
      date:     today,
    }).lean();

    // ── Latest selfie per staff ───────────────────────────────────────────
    //    Most recent session that has a selfie_url (all-time, not just today,
    //    so the card always shows something even if today had no selfie).
    const latestSelfieAgg = await StaffSession.aggregate([
      {
        $match: {
          staff_id:   { $in: staffIds },
          selfie_url: { $nin: [null, ""] },
        },
      },
      { $sort: { login_at: -1 } },
      {
        $group: {
          _id:        "$staff_id",
          selfie_url: { $first: "$selfie_url" },
          location:   { $first: "$location" },
          login_at:   { $first: "$login_at" },
        },
      },
    ]);

    const selfieMap = {};
    for (const s of latestSelfieAgg) {
      selfieMap[s._id.toString()] = {
        selfie_url: s.selfie_url,
        location:   s.location,   // includes formatted_address + place_name
        login_at:   s.login_at,
      };
    }

    // ── Task log counts ───────────────────────────────────────────────────
    const startOfDay    = new Date(`${today}T00:00:00.000Z`);
    const endOfDay      = new Date(`${today}T23:59:59.999Z`);
    const taskLogCounts = await StaffTaskLog.aggregate([
      {
        $match: {
          staff_id:     { $in: staffIds },
          submitted_at: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id:    "$staff_id",
          count:  { $sum: 1 },
          lastAt: { $max: "$submitted_at" },
        },
      },
    ]);

    const taskMap = {};
    for (const t of taskLogCounts) taskMap[t._id.toString()] = t;

    // ── Job-level data ────────────────────────────────────────────────────
    const assignedJobs = await Job.find({
      "workflow_stages.handled_by.user_id": { $in: staffIds },
    })
      .select("job_no customer_name job_status current_stage workflow_stages")
      .lean();

    const jobStatsMap = {};
    for (const id of staffIdStrs) {
      jobStatsMap[id] = {
        activeJobs:           0,
        totalJobSecondsToday: 0,
        totalJobSecondsAll:   0,
        jobsAssignedTotal:    0,
      };
    }

    for (const job of assignedJobs) {
      for (const stage of job.workflow_stages || []) {
        const handlerId = stage.handled_by?.user_id?.toString();
        if (!handlerId || !jobStatsMap[handlerId]) continue;

        jobStatsMap[handlerId].jobsAssignedTotal += 1;

        const hasOpen = (stage.work_sessions || []).some(
          (s) => s.session_start && !s.session_end,
        );
        if (hasOpen) jobStatsMap[handlerId].activeJobs += 1;

        for (const sess of stage.work_sessions || []) {
          if (!sess.session_start) continue;
          const end  = sess.session_end ? new Date(sess.session_end) : new Date();
          const secs = Math.max(
            0,
            Math.floor((end - new Date(sess.session_start)) / 1000),
          );

          jobStatsMap[handlerId].totalJobSecondsAll += secs;

          const sessionDate = (
            sess.work_date || new Date(sess.session_start).toISOString()
          ).slice(0, 10);
          if (sessionDate === today) {
            jobStatsMap[handlerId].totalJobSecondsToday += secs;
          }
        }
      }
    }

    // ── Session map by staff ──────────────────────────────────────────────
    const sessionMap = {};
    for (const s of todaySessions) {
      const key = s.staff_id.toString();
      if (!sessionMap[key]) sessionMap[key] = [];
      sessionMap[key].push(s);
    }

    // ── Compose result ────────────────────────────────────────────────────
    const result = staffList.map((staff) => {
      const id       = staff._id.toString();
      const sessions = sessionMap[id] || [];
      const taskInfo = taskMap[id] || { count: 0, lastAt: null };
      const js       = jobStatsMap[id] || {};

      const todaySeconds = sessions.reduce((acc, s) => {
        if (s.logout_at) return acc + (s.duration_seconds || 0);
        return acc + Math.floor((Date.now() - new Date(s.login_at).getTime()) / 1000);
      }, 0);

      const openSession = sessions.find((s) => !s.logout_at);
      const lastLogout  = sessions
        .filter((s) => s.logout_at)
        .sort((a, b) => new Date(b.logout_at) - new Date(a.logout_at))[0]?.logout_at;

      const lastActivity =
        taskInfo.lastAt > lastLogout ? taskInfo.lastAt : lastLogout;

      return {
        ...staff,
        todaySeconds,
        todaySessions:  sessions.length,
        taskLogsToday:  taskInfo.count,
        currentLoginAt: openSession?.login_at || null,
        lastActivity:   lastActivity || null,
        // latestSelfie.location already has formatted_address + place_name
        latestSelfie:   selfieMap[id] || null,
        jobStats: {
          activeJobs:           js.activeJobs           ?? 0,
          totalJobSecondsToday: js.totalJobSecondsToday ?? 0,
          totalJobSecondsAll:   js.totalJobSecondsAll   ?? 0,
          totalJobDisplayToday: secsToDisplay(js.totalJobSecondsToday ?? 0),
          totalJobDisplayAll:   secsToDisplay(js.totalJobSecondsAll   ?? 0),
          jobsAssignedTotal:    js.jobsAssignedTotal    ?? 0,
        },
      };
    });

    // Online staff first, then alphabetical
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
// Sessions now carry selfie_url + full location (with formatted_address).
// ─────────────────────────────────────────────────────────────────────────────
const getStaffDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const staff = await AdminUsersSchema.findById(id, { password: 0 }).lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const sessions = await StaffSession.find({ staff_id: id })
      .sort({ login_at: -1 })
      .lean();

    const taskLogs = await StaffTaskLog.find({ staff_id: id })
      .sort({ submitted_at: -1 })
      .lean();

    const assignedJobs = await Job.find({
      "workflow_stages.handled_by.user_id": id,
    })
      .select(
        "job_no customer_name company_name job_status current_stage workflow_stages order_date createdAt",
      )
      .lean();

    let totalJobSeconds = 0;
    let activeJobCount  = 0;

    const jobAssignments = assignedJobs.map((job) => {
      const { stages, totalSeconds } = extractUserWorkFromStages(
        job.workflow_stages,
        id,
      );
      const isCurrentlyActive = stages.some((s) => s.has_open_session);

      totalJobSeconds += totalSeconds;
      if (isCurrentlyActive) activeJobCount += 1;

      return {
        _id:              job._id,
        job_no:           job.job_no,
        customer_name:    job.customer_name,
        company_name:     job.company_name || "",
        job_status:       job.job_status,
        order_date:       job.order_date || job.createdAt,
        current_stage:    job.current_stage,
        stages,
        totalSeconds,
        totalDisplay:     secsToDisplay(totalSeconds),
        isCurrentlyActive,
      };
    });

    jobAssignments.sort((a, b) => {
      if (a.isCurrentlyActive !== b.isCurrentlyActive)
        return a.isCurrentlyActive ? -1 : 1;
      return b.totalSeconds - a.totalSeconds;
    });

    return successResponse(res, "Staff details fetched.", {
      staff,
      sessions,   // each session carries selfie_url + location.formatted_address
      taskLogs,
      jobAssignments,
      jobTimeSummary: {
        totalSeconds: totalJobSeconds,
        totalDisplay: secsToDisplay(totalJobSeconds),
        activeJobCount,
        jobCount:     jobAssignments.length,
      },
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
    const { id }    = req.params;
    const { jobNo } = req.query;

    const staff = await AdminUsersSchema.findById(id, {
      name: 1, role: 1, email: 1, profileImg: 1,
    }).lean();
    if (!staff) return errorResponse(res, "Staff not found.");

    const jobFilter = { "workflow_stages.handled_by.user_id": id };
    if (jobNo) jobFilter.job_no = jobNo;

    const assignedJobs = await Job.find(jobFilter)
      .select(
        "job_no customer_name company_name job_status current_stage workflow_stages order_date createdAt estimated_delivery_date",
      )
      .lean();

    let totalSeconds   = 0;
    let activeJobCount = 0;

    const jobs = assignedJobs.map((job) => {
      const { stages, totalSeconds: jobSecs } = extractUserWorkFromStages(
        job.workflow_stages,
        id,
      );
      const isCurrentlyActive = stages.some((s) => s.has_open_session);

      totalSeconds   += jobSecs;
      if (isCurrentlyActive) activeJobCount += 1;

      return {
        _id:                     job._id,
        job_no:                  job.job_no,
        customer_name:           job.customer_name,
        company_name:            job.company_name || "",
        job_status:              job.job_status,
        order_date:              job.order_date || job.createdAt,
        estimated_delivery_date: job.estimated_delivery_date,
        current_stage:           job.current_stage,
        totalSeconds:            jobSecs,
        totalDisplay:            secsToDisplay(jobSecs),
        isCurrentlyActive,
        stages,
      };
    });

    jobs.sort((a, b) => {
      if (a.isCurrentlyActive !== b.isCurrentlyActive)
        return a.isCurrentlyActive ? -1 : 1;
      return b.totalSeconds - a.totalSeconds;
    });

    return successResponse(res, "Staff job time fetched.", {
      staff,
      summary: {
        totalSeconds,
        totalDisplay:  secsToDisplay(totalSeconds),
        activeJobCount,
        jobCount:      jobs.length,
      },
      jobs,
    });
  } catch (err) {
    console.error("[getStaffJobTime]", err);
    return errorResponse(res, "Failed to fetch job time.");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /task-log
// Body: { staffId, message, job_ref?, hour_label? }
// ─────────────────────────────────────────────────────────────────────────────
const submitTaskLog = async (req, res) => {
  try {
    const { staffId, message, job_ref, hour_label } = req.body;
    if (!staffId)         return errorResponse(res, "staffId is required.");
    if (!message?.trim()) return errorResponse(res, "message is required.");

    const now   = new Date();
    const label =
      hour_label ||
      now.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true,
      });

    const log = await StaffTaskLog.create({
      staff_id:     staffId,
      message:      message.trim(),
      job_ref:      job_ref?.trim() || "",
      hour_label:   label,
      submitted_at: now,
      submitted_by: req.user?._id || null,
    });

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
    const { logId }  = req.params;
    const deleted    = await StaffTaskLog.findByIdAndDelete(logId);
    if (!deleted) return errorResponse(res, "Log entry not found.");
    return successResponse(res, "Log deleted.");
  } catch (err) {
    console.error("[deleteTaskLog]", err);
    return errorResponse(res, "Failed to delete log.");
  }
};

module.exports = {
  recordLogin,
  recordLogout,
  getMonitorList,
  getStaffDetails,
  getStaffJobTime,
  submitTaskLog,
  deleteTaskLog,
};