const express = require("express");
const router  = express.Router();
const {
  recordLogin, recordLogout, startBreak, endBreak,
  getMonitorList, getStaffDetails, getStaffJobTime,
  submitTaskLog, deleteTaskLog,getSession
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

module.exports = router;