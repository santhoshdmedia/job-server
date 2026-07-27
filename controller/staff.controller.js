const AdminUser = require("../modals/adminusers.modals"); // adjust path to your model
const bcrypt = require("bcryptjs");
const _ = require("lodash");

// ─── helpers ──────────────────────────────────────────────────────────────────
const ok  = (res, data, msg = "Success")        => res.status(200).json({ success: true,  message: msg,  data });
const err = (res, msg  = "Something went wrong", code = 500) => res.status(code).json({ success: false, message: msg });

// ─── GET all staff ────────────────────────────────────────────────────────────
// GET /api/staff
const getAllStaff = async (req, res) => {
  try {
    const { role, available, search } = req.query;
    const where = {};

    if (role)      where.role      = role;
    if (available !== undefined) where.available = available === "true";

    if (search && search.trim()) {
      const s = search.trim();
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex special chars

      const orConditions = [
        { name:  { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];

      // phone is a Number field — Mongo can't run $regex against numbers,
      // which is what threw "Can't use $options with Number". Only add a
      // phone match when the search term is itself numeric, and match it
      // as an actual number instead of a regex.
      if (/^\d+$/.test(s)) {
        orConditions.push({ phone: Number(s) });
      }

      where.$or = orConditions;
    }

    const staff = await AdminUser.find(where).select("-password").lean();
    return ok(res, staff);
  } catch (e) {
    console.error("getAllStaff:", e);
    return err(res);
  }
};

// ─── GET single staff ─────────────────────────────────────────────────────────
// GET /api/staff/:id
const getSingleStaff = async (req, res) => {
  try {
    const staff = await AdminUser.findById(req.params.id).select("-password").lean();
    if (!staff) return err(res, "Staff not found", 404);
    return ok(res, staff);
  } catch (e) {
    console.error("getSingleStaff:", e);
    return err(res);
  }
};

// ─── CREATE staff ─────────────────────────────────────────────────────────────
// POST /api/staff
const createStaff = async (req, res) => {
  try {
    const { name, email, phone, password, role, profileImg, pagePermissions, staff_category } = req.body;

    if (!name || !email || !phone || !password || !role)
      return err(res, "name, email, phone, password and role are required", 400);

    const exists = await AdminUser.findOne({ email });
    if (exists) return err(res, "Email already registered", 409);

    const hashed = await bcrypt.hash(password, 10);

    const staff = await AdminUser.create({
      name,
      email,
      phone,
      password: hashed,
      role,
      profileImg: profileImg || "",
      pagePermissions: pagePermissions || [],
      staff_category: staff_category === "marketing" ? "marketing" : "office",
    });

    const result = staff.toObject();
    delete result.password;
    return ok(res, result, "Staff created successfully");
  } catch (e) {
    console.error("createStaff:", e);
    return err(res);
  }
};

// ─── UPDATE staff ─────────────────────────────────────────────────────────────
// PUT /api/staff/:id
const updateStaff = async (req, res) => {
  try {
    const { password, ...rest } = req.body;

    // If password update requested, hash it
    if (password && password.trim().length > 0) {
      rest.password = await bcrypt.hash(password, 10);
    }

    const updated = await AdminUser
      .findByIdAndUpdate(req.params.id, rest, { new: true, runValidators: true })
      .select("-password")
      .lean();

    if (!updated) return err(res, "Staff not found", 404);
    return ok(res, updated, "Staff updated successfully");
  } catch (e) {
    console.error("updateStaff:", e);
    return err(res);
  }
};

// ─── DELETE staff ─────────────────────────────────────────────────────────────
// DELETE /api/staff/:id
const deleteStaff = async (req, res) => {
  try {
    const deleted = await AdminUser.findByIdAndDelete(req.params.id);
    if (!deleted) return err(res, "Staff not found", 404);
    return ok(res, null, "Staff deleted successfully");
  } catch (e) {
    console.error("deleteStaff:", e);
    return err(res);
  }
};

// ─── TOGGLE availability ──────────────────────────────────────────────────────
// PATCH /api/staff/:id/toggle-available
const toggleAvailable = async (req, res) => {
  try {
    const staff = await AdminUser.findById(req.params.id);
    if (!staff) return err(res, "Staff not found", 404);
    staff.available = !staff.available;
    await staff.save();
    return ok(res, { available: staff.available }, "Availability updated");
  } catch (e) {
    console.error("toggleAvailable:", e);
    return err(res);
  }
};

// ─── UPDATE page permissions ──────────────────────────────────────────────────
// PATCH /api/staff/:id/permissions
const updatePermissions = async (req, res) => {
  try {
    const { pagePermissions } = req.body;
    if (!Array.isArray(pagePermissions))
      return err(res, "pagePermissions must be an array", 400);

    const updated = await AdminUser
      .findByIdAndUpdate(req.params.id, { pagePermissions }, { new: true })
      .select("-password")
      .lean();

    if (!updated) return err(res, "Staff not found", 404);
    return ok(res, updated, "Permissions updated");
  } catch (e) {
    console.error("updatePermissions:", e);
    return err(res);
  }
};

module.exports = {
  getAllStaff,
  getSingleStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  toggleAvailable,
  updatePermissions,
};