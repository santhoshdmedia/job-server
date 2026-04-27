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
router.get("/",           VerfiyToken, getAllStaff);
router.get("/:id",        VerfiyToken, getSingleStaff);
router.post("/",          VerfiyToken, createStaff);
router.put("/:id",        VerfiyToken, updateStaff);
router.delete("/:id",     VerfiyToken, deleteStaff);

// ── Special actions ───────────────────────────────────────────────────────────
router.patch("/:id/toggle-available", VerfiyToken, toggleAvailable);
router.patch("/:id/permissions",      VerfiyToken, updatePermissions);

module.exports = router;

// ── Register in your main app.js / server.js ──────────────────────────────────
// const staffRoutes = require("./routes/staff.routes");
// app.use("/api/staff", staffRoutes);