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

const requireSuperAdmin = (req, res, next) => {
  const role = req.user?.role?.toLowerCase?.() ?? "";
  if (["super_admin", "super admin", "admin"].includes(role)) return next();
  return res.status(403).json({ success: false, message: "Admin access required." });
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
router.post("/session/force-logout", requireSuperAdmin, forceLogout);

// After-7-PM work permission
router.post("/session/permission/request",            requestPermission);         // staff asks to keep working late
router.get ("/session/permission/pending",             requireSuperAdmin, getPendingPermissions); // admin sees queue
router.post("/session/permission/:staffId/respond",    requireSuperAdmin, respondPermission);      // admin approves/rejects

// Monitor — admin dashboard
router.get("/monitor",               getMonitorList);
router.get("/monitor/:id/details",   getStaffDetails);
router.get("/monitor/:id/job-time",  getStaffJobTime);

// Task logs
router.post  ("/task-log",         submitTaskLog);
router.delete("/task-log/:logId",   deleteTaskLog);

// ── Assigned Tasks (stock-checking style jobs assigned by admin) ──────────
// Admin creates/oversees assignments
router.post  ("/assigned-tasks",                        requireSuperAdmin, assignTask);
router.get   ("/assigned-tasks",                         requireSuperAdmin, getAllAssignedTasks); // ?status=resume_requested etc.
router.delete("/assigned-tasks/:taskId",                 requireSuperAdmin, deleteAssignedTask);
router.post  ("/assigned-tasks/:taskId/resume",          requireSuperAdmin, resumeAssignedTask); // only super admin can resume a stopped task

// Staff acts on their own tasks
router.get   ("/assigned-tasks/staff/:staffId",          getAssignedTasksForStaff);
router.post  ("/assigned-tasks/:taskId/start",            startAssignedTask);
router.post  ("/assigned-tasks/:taskId/stop",             stopAssignedTask);          // body: { notes } — popup notes required
router.post  ("/assigned-tasks/:taskId/complete",         completeAssignedTask);
router.post  ("/assigned-tasks/:taskId/request-resume",   requestResumeTask);          // staff asks admin to resume

module.exports = router;
