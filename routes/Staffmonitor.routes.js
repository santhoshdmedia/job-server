/**
 * staffMonitor.routes.js
 *
 * Mount in your main Express app:
 *   const staffMonitorRouter = require("./routes/staffMonitor.routes");
 *   app.use("/api/staff", authMiddleware, staffMonitorRouter);
 *
 * The `authMiddleware` must attach req.user (the logged-in admin_users doc).
 * Super-admin-only routes are additionally guarded by `requireSuperAdmin`.
 */

const express = require("express");
const router  = express.Router();

const {
  recordLogin,
  recordLogout,
  getMonitorList,
  getStaffDetails,
  submitTaskLog,
  deleteTaskLog,getStaffJobTime
} = require("../controller/Staffmonitor.controller");  // adjust path

// ── Inline guard (replace with your existing permission middleware) ───────────
const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role === "super admin" || req.user?.role === "admin") return next();
  return res.status(403).json({ success: false, message: "Super admin access required." });
};

// ── Session ───────────────────────────────────────────────────────────────────
// Called from frontend on every login / logout
router.post("/session/login",  recordLogin);
router.post("/session/logout", recordLogout);

// ── Monitor list (super admin dashboard) ─────────────────────────────────────
router.get("/monitor", getMonitorList);
router.get("/monitor/:id/details", getStaffDetails);
router.get   ("/monitor/:id/job-time", getStaffJobTime);  

// ── Task logs ─────────────────────────────────────────────────────────────────
// Staff submit their own updates; super admin can add logs for any staff
router.post("/task-log",           submitTaskLog);
router.delete("/task-log/:logId", deleteTaskLog);

module.exports = router;