const { AdminUsersSchema } = require("./models_import");
const {
  ADMIN_USERS_ADDED_SUCCESS,
  ADMIN_USERS_ADDED_FAILED,
  ADMIN_USERS_GETTED_SUCCESS,
  ADMIN_USER_GETTED_FAILED,
  ADMIN_USER_UPDATED_SUCCESS,
  ADMIN_USER_UPDATED_FAILED,
  ADMIN_USER_DELETED_SUCCESS,
  ADMIN_USER_DELETED_FAILED,
  ADMIN_USER_ACCOUNT_ALREADY_EXISTS,
} = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { EncryptPassword } = require("../helper/shared.helper");

// ─────────────────────────────────────────────
// Available pages in the system
// ─────────────────────────────────────────────
const AVAILABLE_PAGES = [
  { name: "Dashboard",        value: "dashboard" },
  { name: "Orders",           value: "orders" },
  { name: "Cancelled Orders", value: "cancelled-orders" },
  { name: "Categories",       value: "categories" },
  { name: "Main Category",    value: "main-category" },
  { name: "Sub Category",     value: "sub-category" },
  { name: "Products",         value: "product-details" },
  { name: "Vendor Products",  value: "Vendor-product-details" },
  { name: "Homepage",         value: "homepage" },
  { name: "Banners",          value: "banners" },
  { name: "Product Section",  value: "product-section" },
  { name: "Coupons",          value: "coupons" },
  { name: "Admin Users",      value: "admin-users" },
  { name: "Customers",        value: "client-users" },
  { name: "BNI",              value: "BNI" },
  { name: "Vendors",          value: "vendors" },
  { name: "Blogs",            value: "blogs" },
  { name: "Review",           value: "review" },
  { name: "Enquires",         value: "enquires" },
  { name: "Bulk Enquires",    value: "bulk-enquires" },
  { name: "Settings",         value: "settings" },

  // BUG FIX: these are the job-workflow pages this app actually routes to
  // (see frontend src/config/Router.jsx `pageName` props). They were
  // missing from this list entirely, so they never appeared as options
  // when a super admin tried to grant another role permission to view
  // them — the "Production Upload Panel" (and the other operational
  // panels) could only ever be seen by super admins, never assigned out.
  { name: "Users / Stock",              value: "users" },
  { name: "Admin Job Management",       value: "admin-job-management" },
  { name: "Site Visit Dashboard",       value: "site-visit-dashboard" },
  { name: "My Jobs",                    value: "my-jobs" },
  { name: "Material Issue Manager",     value: "material-issue-manager" },
  { name: "Designer Job Dashboard",     value: "admin-designer-job-dashboard" },
  { name: "Production Upload Panel",    value: "production-panel" },
  { name: "Quality Check Dashboard",    value: "quality-check-dashboard" },
  { name: "Pickup Dashboard",           value: "pickup-dashboard" },
  { name: "Delivery Panel",             value: "delivery-panel" },
  { name: "Erection Panel",             value: "erection-panel" },
  { name: "Staff Monitor",              value: "Staff-monitor" },
  { name: "Staff Admin",                value: "staff-admin" },
  { name: "My Tasks",                   value: "my-tasks" },
];

// ─────────────────────────────────────────────
// Role-based default page access
// ─────────────────────────────────────────────
const ROLE_DEFAULT_PAGES = {
  "super admin":    null, // handled separately — full access
  "Frontend admin": ["dashboard", "BNI", "vendors"],
  "accounting team":  ["dashboard", "orders", "settings"],
  "designing team":   ["dashboard", "orders", "settings", "admin-designer-job-dashboard", "my-jobs", "my-tasks"],
  // BUG FIX: production team had no route to the actual Production Upload
  // Panel in its default permissions, only unrelated e-commerce pages.
  "production team":  ["dashboard", "orders", "settings", "production-panel", "material-issue-manager", "my-jobs", "my-tasks"],
  "quality check":    ["orders", "settings", "quality-check-dashboard", "my-jobs", "my-tasks"],
  "packing team":     ["orders"],
  "delivery team":    ["dashboard", "orders", "settings", "delivery-panel", "pickup-dashboard", "my-jobs", "my-tasks"],
  "admin":null
};

// ─────────────────────────────────────────────
// Helper: Build permissions array for a role
// ─────────────────────────────────────────────
const getDefaultPermissionsForRole = (role) => {
  // Super admin → full access to all pages
  if (role === "super admin"||role === "admin") {
    return AVAILABLE_PAGES.map((page) => ({
      pageName:  page.value,
      canView:   true,
      canEdit:   true,
      canDelete: true,
    }));
  }

  const allowedPages = ROLE_DEFAULT_PAGES[role] || [];

  return AVAILABLE_PAGES.map((page) => ({
    pageName:  page.value,
    canView:   allowedPages.includes(page.value),
    canEdit:   false,
    canDelete: false,
  }));
};

// ─────────────────────────────────────────────
// Helper: Strip sensitive fields from a user object
// ─────────────────────────────────────────────
const sanitizeUser = (userDoc) => {
  const user = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  delete user.password;
  return user;
};

// ─────────────────────────────────────────────
// POST /admin-users  →  Add new admin user
// ─────────────────────────────────────────────
const addAdmin = async (req, res) => {
  const { email, password, name, role, phone, pagePermissions } = req.body;

  try {
    // Validate required fields
    if (!email || !password || !name) {
      return errorResponse(res, "All fields (email, password, name, role, phone) are required.");
    }

    // Check for duplicate email
    const existing = await AdminUsersSchema.findOne({ email });
    if (existing) {
      return errorResponse(res, ADMIN_USER_ACCOUNT_ALREADY_EXISTS);
    }

    // Resolve page permissions (custom or role-default)
    const finalPagePermissions =
      pagePermissions && pagePermissions.length > 0
        ? pagePermissions
        : getDefaultPermissionsForRole(role);

    const newUser = new AdminUsersSchema({
      email,
      password: await EncryptPassword(password),
      name,
      role,
      phone,
      pagePermissions: finalPagePermissions,
    });

    const savedUser = await newUser.save();

    return successResponse(res, ADMIN_USERS_ADDED_SUCCESS, sanitizeUser(savedUser));
  } catch (error) {
    console.error("[addAdmin]", error);
    return errorResponse(res, ADMIN_USERS_ADDED_FAILED);
  }
};

// ─────────────────────────────────────────────
// GET /admin-users  →  Fetch all admin users
// ─────────────────────────────────────────────
const getAdmin = async (req, res) => {
  try {
    const users = await AdminUsersSchema.find({}, { password: 0 }).lean();
    return successResponse(res, ADMIN_USERS_GETTED_SUCCESS, users);
  } catch (error) {
    console.error("[getAdmin]", error);
    return errorResponse(res, ADMIN_USER_GETTED_FAILED);
  }
};

// ─────────────────────────────────────────────
// PUT /admin-users/:id  →  Update an admin user
// ─────────────────────────────────────────────
const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, pagePermissions, ...rest } = req.body;

    // Check if email is being taken by another user
    if (email) {
      const duplicate = await AdminUsersSchema.findOne({
        email,
        _id: { $ne: id },
      });
      if (duplicate) {
        return errorResponse(res, ADMIN_USER_ACCOUNT_ALREADY_EXISTS);
      }
      rest.email = email;
    }

    // Encrypt new password if provided
    if (password) {
      rest.password = await EncryptPassword(password);
    }

    // Update page permissions if provided
    if (pagePermissions && pagePermissions.length > 0) {
      rest.pagePermissions = pagePermissions;
    }

    const updated = await AdminUsersSchema.findByIdAndUpdate(
      id,
      { $set: rest },
      { new: true, projection: { password: 0 } }
    );

    if (!updated) {
      return errorResponse(res, "Admin user not found.");
    }

    return successResponse(res, ADMIN_USER_UPDATED_SUCCESS, updated);
  } catch (error) {
    console.error("[updateAdmin]", error);
    return errorResponse(res, ADMIN_USER_UPDATED_FAILED);
  }
};

// ─────────────────────────────────────────────
// DELETE /admin-users/:id  →  Delete an admin user
// ─────────────────────────────────────────────
const deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await AdminUsersSchema.findByIdAndDelete(id);
    if (!deleted) {
      return errorResponse(res, "Admin user not found.");
    }

    return successResponse(res, ADMIN_USER_DELETED_SUCCESS);
  } catch (error) {
    console.error("[deleteAdmin]", error);
    return errorResponse(res, ADMIN_USER_DELETED_FAILED);
  }
};

// ─────────────────────────────────────────────
// GET /admin-users/pages  →  List all available pages
// ─────────────────────────────────────────────
const getAvailablePages = async (req, res) => {
  try {
    return successResponse(res, "Pages fetched successfully", AVAILABLE_PAGES);
  } catch (error) {
    console.error("[getAvailablePages]", error);
    return errorResponse(res, "Failed to fetch pages");
  }
};

module.exports = {
  addAdmin,
  getAdmin,
  deleteAdmin,
  updateAdmin,
  getAvailablePages,
};