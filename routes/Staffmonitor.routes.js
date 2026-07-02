const express = require("express");
const router  = express.Router();
const {
  recordLogin, recordLogout, startBreak, endBreak,
  getMonitorList, getStaffDetails, getStaffJobTime,
  submitTaskLog, deleteTaskLog, getSession,
  assignTask, getAssignedTasksForStaff, getAllAssignedTasks,
  startAssignedTask, stopAssignedTask, completeAssignedTask,
  requestResumeTask, resumeAssignedTask, deleteAssignedTask,
} = require("../controller/Staffmonitor.controller");

const requireSuperAdmin = (req, res, next) => {
  const role = req.user?.role?.toLowerCase?.() ?? "";
  if (["super_admin", "super admin", "admin"].includes(role)) return next();
  return res.status(403).json({ success: false, message: "Admin access required." });
};

// Session — any authenticated user
router.post("/session/login",       recordLogin);
router.post("/session/logout",      recordLogout);
router.post("/session/break/start", startBreak);
router.get("/session/:staffId", getSession);
router.post("/session/break/end",   endBreak);

// Monitor — admin dashboard
router.get("/monitor",               getMonitorList);
router.get("/monitor/:id/details",   getStaffDetails);
router.get("/monitor/:id/job-time",  getStaffJobTime);

// Task logs
router.post  ("/task-log",         submitTaskLog);
router.delete("/task-log/:logId",   deleteTaskLog);

// ── Assigned Tasks (stock-checking style jobs assigned by admin) ──────────
// Admin creates/oversees assignments
router.post  ("/assigned-task",                        requireSuperAdmin, assignTask);
router.get   ("/assigned-task",                         requireSuperAdmin, getAllAssignedTasks); // ?status=resume_requested etc.
router.delete("/assigned-task/:taskId",                 requireSuperAdmin, deleteAssignedTask);
router.post  ("/assigned-task/:taskId/resume",          requireSuperAdmin, resumeAssignedTask); // only super admin can resume a stopped task

// Staff acts on their own tasks
router.get   ("/assigned-task/staff/:staffId",          getAssignedTasksForStaff);
router.post  ("/assigned-task/:taskId/start",            startAssignedTask);
router.post  ("/assigned-task/:taskId/stop",             stopAssignedTask);          // body: { notes } — popup notes required
router.post  ("/assigned-task/:taskId/complete",         completeAssignedTask);
router.post  ("/assigned-task/:taskId/request-resume",   requestResumeTask);          // staff asks admin to resume

module.exports = router;