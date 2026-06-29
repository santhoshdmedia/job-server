/**
 * staffMonitor.routes.js
 *
 * Mount in your main Express app:
 *   const staffMonitorRouter = require("./routes/staffMonitor.routes");
 *   app.use("/api/staff-monitor", authMiddleware, staffMonitorRouter);
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
  getStaffJobTime,
  submitTaskLog,
  deleteTaskLog,
} = require("../controller/Staffmonitor.controller"); // adjust path as needed

// ── Inline role guard (replace with your own middleware if preferred) ─────────
const requireSuperAdmin = (req, res, next) => {
  const role = req.user?.role?.toLowerCase?.() ?? "";
  if (role === "super_admin" || role === "super admin" || role === "admin") {
    return next();
  }
  return res.status(403).json({ success: false, message: "Admin access required." });
};

// ── Session (called from frontend on every login / logout) ────────────────────
// No role guard — every authenticated user can record their own session.
router.post("/session/login",  recordLogin);
router.post("/session/logout", recordLogout);

// ── Monitor list & details (admin-only dashboard views) ───────────────────────
router.get("/monitor", getMonitorList);
router.get("/monitor/:id/details", getStaffDetails);
router.get("/monitor/:id/job-time", getStaffJobTime);

// ── Task logs ─────────────────────────────────────────────────────────────────
// Staff submit their own updates; admin can also add logs on behalf of staff.
router.post  ("/task-log",         submitTaskLog);
router.delete("/task-log/:logId", deleteTaskLog);

module.exports = router;