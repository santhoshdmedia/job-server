const router = require("express").Router();
const {
  getAllStaff,
  getSingleStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  toggleAvailable,
  updatePermissions,
} = require("../controller/staff.controller");

const { VerfiyToken } = require("../helper/shared.helper"); // your existing auth middleware

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.get("/",            getAllStaff);
router.get("/:id",         getSingleStaff);
router.post("/", createStaff);
router.put("/:id",         updateStaff);
router.delete("/:id",      deleteStaff);

// ── Special actions ───────────────────────────────────────────────────────────
router.patch("/:id/toggle-available",  toggleAvailable);
router.patch("/:id/permissions",       updatePermissions);

module.exports = router;

// ── Register in your main app.js / server.js ──────────────────────────────────
// const staffRoutes = require("./routes/staff.routes");
// app.use("/api/staff", staffRoutes);