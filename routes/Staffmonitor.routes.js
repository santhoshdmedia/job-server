const express = require("express");
const router  = express.Router();
const {
  recordLogin, recordLogout, startBreak, endBreak,
  getMonitorList, getStaffDetails, getStaffJobTime,
  submitTaskLog, deleteTaskLog, getSession,
  assignTask, getAssignedTasksForStaff, getAllAssignedTasks,
  startAssignedTask, stopAssignedTask, completeAssignedTask,
  requestResumeTask, resumeAssignedTask, deleteAssignedTask,
  forceLogout, requestPermission, getPendingPermissions, respondPermission,
  editSessionTime, createManualSession, updatePaySettings,
  startFieldWork, finishFieldWork, requestFieldWorkResume,
  resumeFieldWork, closeFieldWork, getFieldWorkQueue,
  exportMonthlyAttendance, exportDailyAttendance,
} = require("../controller/Staffmonitor.controller");
const { VerfiyToken } = require("../helper/shared.helper");
const AdminUsersSchema = require("../modals/adminusers.modals");

// ── Auth: verify the JWT, then hydrate req.user from the DB ───────────────
// (VerfiyToken alone only sets req.userData with the raw token payload —
// role-gated routes below need the fresh, authoritative user record.)
const attachUser = async (req, res, next) => {
  try {
    const id = req.userData?.id;
    if (!id) return res.status(401).json({ success: false, message: "Invalid token." });
    const user = await AdminUsersSchema.findById(id).select("name email role profileImg").lean();
    if (!user) return res.status(401).json({ success: false, message: "User not found." });
    req.user = user; // { _id, name, email, role, profileImg }
    next();
  } catch (err) {
    console.error("[attachUser]", err);
    return res.status(401).json({ success: false, message: "Authentication failed." });
  }
};



// Every route below requires a logged-in user.
router.use(VerfiyToken, attachUser);

// Session — any authenticated user
router.post("/session/login",       recordLogin);
router.post("/session/logout",      recordLogout);
router.post("/session/break/start", startBreak);
router.get("/session/:staffId", getSession);
router.post("/session/break/end",   endBreak);

// Force-logout — super admin closes out a staff member's session
// (e.g. they forgot to log out, app crashed, left a tab open overnight).
router.post("/session/force-logout",  forceLogout);

// Manual login/logout time correction — super admin only.
// PATCH /staff-monitor/session/:sessionId/edit-time  body: { login_at, logout_at? }
router.patch("/session/:sessionId/edit-time",  editSessionTime);

// Manually add a brand-new attendance entry — super admin only.
// POST /staff-monitor/session/manual-entry  body: { staffId, login_at, logout_at? }
router.post("/session/manual-entry",  createManualSession);

// Pay & hours settings — super admin only.
// PATCH /staff-monitor/staff/:staffId/pay-settings  body: { standard_hours_per_day?, monthly_salary? }
router.patch("/staff/:staffId/pay-settings",  updatePaySettings);

// After-7-PM work permission
router.post("/session/permission/request",            requestPermission);         // staff asks to keep working late
router.get ("/session/permission/pending",              getPendingPermissions); // admin sees queue
router.post("/session/permission/:staffId/respond",     respondPermission);      // admin approves/rejects

// ── Field Work — marketing team "going out" with an estimated-hours ETA ───
// Staff-initiated: start / finish-early / request-resume-when-frozen.
router.post("/session/field-work/start",           startFieldWork);
router.post("/session/field-work/finish",          finishFieldWork);
router.post("/session/field-work/resume-request",  requestFieldWorkResume);
// Admin-only: see who's frozen/waiting, resume them (optionally granting
// more hours), or force-close their window instead.
router.get ("/session/field-work/pending",           getFieldWorkQueue);
router.post("/session/field-work/:staffId/resume",   resumeFieldWork);
router.post("/session/field-work/:staffId/close",    closeFieldWork);

// Monitor — admin dashboard
router.get("/monitor",               getMonitorList);
router.get("/monitor/:id/details",   getStaffDetails);
router.get("/monitor/:id/job-time",  getStaffJobTime);

// Attendance export — month-wise, date-wise in/out register as .xlsx
// GET /staff-monitor/export/attendance?month=YYYY-MM&staffId=<optional>
router.get("/export/attendance",  exportMonthlyAttendance);

// Attendance export — single day's in/out + working hours as .xlsx
// GET /staff-monitor/export/attendance/daily?date=YYYY-MM-DD&staffId=<optional>
router.get("/export/attendance/daily",  exportDailyAttendance);

// Task logs
router.post  ("/task-log",         submitTaskLog);
router.delete("/task-log/:logId",   deleteTaskLog);

// ── Assigned Tasks (stock-checking style jobs assigned by admin) ──────────
// Admin creates/oversees assignments
router.post  ("/assigned-tasks",                         assignTask);
router.get   ("/assigned-tasks",                          getAllAssignedTasks); // ?status=resume_requested etc.
router.delete("/assigned-tasks/:taskId",                  deleteAssignedTask);
router.post  ("/assigned-tasks/:taskId/resume",           resumeAssignedTask); // only super admin can resume a stopped task

// Staff acts on their own tasks
router.get   ("/assigned-tasks/staff/:staffId",          getAssignedTasksForStaff);
router.post  ("/assigned-tasks/:taskId/start",            startAssignedTask);
router.post  ("/assigned-tasks/:taskId/stop",             stopAssignedTask);          // body: { notes } — popup notes required
router.post  ("/assigned-tasks/:taskId/complete",         completeAssignedTask);
router.post  ("/assigned-tasks/:taskId/request-resume",   requestResumeTask);          // staff asks admin to resume

module.exports = router;