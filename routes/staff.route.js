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

const { VerfiyToken } = require("../helper/shared.helper"); // your existing auth middleware
const AdminUsersSchema = require("../modals/adminusers.modals");

// Same attachUser/pattern used in Staffmonitor.routes.js —
// used only to gate the payroll-sensitive routes below (salary, working hours).
const attachUser = async (req, res, next) => {
  try {
    const id = req.userData?.id;
    if (!id) return res.status(401).json({ success: false, message: "Invalid token." });
    const user = await AdminUsersSchema.findById(id).select("name email role").lean();
    if (!user) return res.status(401).json({ success: false, message: "User not found." });
    req.user = user;
    next();
  } catch (e) {
    console.error("[staff.route][attachUser]", e);
    return res.status(401).json({ success: false, message: "Authentication failed." });
  }
};


// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get("/",            getAllStaff);
router.get("/:id",         getSingleStaff);
router.post("/", createStaff);
router.put("/:id",         updateStaff);
router.delete("/:id",      deleteStaff);

// ── Special actions ───────────────────────────────────────────────────────────
router.patch("/:id/toggle-available",  toggleAvailable);
router.patch("/:id/permissions",       updatePermissions);

// ── Payroll / custom hours (super admin only) ───────────────────────────────
// Salary is always entered manually here — there is no auto-calculation.
router.patch("/:id/salary",         VerfiyToken, attachUser,  updateSalary);
router.patch("/:id/working-hours",  VerfiyToken, attachUser,  updateWorkingHours);

module.exports = router;

// ── Register in your main app.js / server.js ──────────────────────────────────
// const staffRoutes = require("./routes/staff.routes");
// app.use("/api/staff", staffRoutes);