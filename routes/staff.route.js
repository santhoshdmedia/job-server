const router = require("express").Router();
const {
  getAllStaff,
  getSingleStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  toggleAvailable,
  updatePermissions,
  updateSalary,
  updateWorkingHours,
} = require("../controller/staff.controller");

const { authenticate } = require("../helper/shared.helper");
const { requireSuperAdmin } = require("../middleware/permission.middleware");
const AdminUsersSchema = require("../modals/adminusers.modals");

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get("/",            getAllStaff);
router.get("/:id",         getSingleStaff);
router.post("/",           authenticate, requireSuperAdmin, createStaff);
router.put("/:id",         authenticate, updateStaff);
router.delete("/:id",      authenticate, requireSuperAdmin, deleteStaff);

// ── Special actions ───────────────────────────────────────────────────────────
router.patch("/:id/toggle-available",  authenticate, toggleAvailable);
router.patch("/:id/permissions",       authenticate, requireSuperAdmin, updatePermissions);

// ── Payroll / custom hours (super admin only) ───────────────────────────────
// Salary is always entered manually here — there is no auto-calculation.
router.patch("/:id/salary",         authenticate, requireSuperAdmin, updateSalary);
router.patch("/:id/working-hours",  authenticate, requireSuperAdmin, updateWorkingHours);

module.exports = router;

// ── Register in your main app.js / server.js ──────────────────────────────────
// const staffRoutes = require("./routes/staff.routes");
// app.use("/api/staff", staffRoutes);