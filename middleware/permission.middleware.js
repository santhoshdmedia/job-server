const _ = require("lodash");
const jwt = require("jsonwebtoken");
const { AdminUsersSchema } = require("../controller/models_import");
const { errorResponse } = require("../helper/response.helper");

// Action permission definitions and role defaults for backward compatibility
const ROLE_ACTION_DEFAULTS = {
  "super admin": ["*"],
  "admin": ["*"],
  "designing head": ["assign_designer", "approve_design", "create_job"],
  "designing team": ["approve_design", "assign_designer"],
  "production team": ["start_production", "assign_production", "issue_material", "store_material_allocation"],
  "quality check": ["qc"],
  "delivery team": ["delivery", "complete_job"],
  "accounting team": ["create_job", "approve_job", "delivery"],
};

/**
 * Checks if user is authenticated and is a super admin
 */
const requireSuperAdmin = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return errorResponse(res, "Authentication required", 401);
    }
    const role = (user.role || "").toLowerCase().trim();
    if (role === "super admin" || role === "admin" || user.is_super_admin || user.isSuperAdmin || user.is_Special) {
      return next();
    }
    return errorResponse(res, "Super Admin permission required", 403);
  } catch (error) {
    console.error("[requireSuperAdmin]", error);
    return errorResponse(res, "Permission check failed", 500);
  }
};

/**
 * Middleware factory to check action-level permissions
 * @param {string} actionName - Name of the action (e.g. 'create_job', 'approve_job', etc.)
 */
const requireActionPermission = (actionName) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return errorResponse(res, "Authentication required", 401);
      }

      const role = (user.role || "").toLowerCase().trim();

      // Super Admin and Admin bypass all checks
      if (role === "super admin" || role === "admin" || user.is_super_admin || user.isSuperAdmin || user.is_Special) {
        return next();
      }

      // Check explicit actionPermissions array
      const actionPerms = Array.isArray(user.actionPermissions)
        ? user.actionPermissions.map((p) => (typeof p === "string" ? p.toLowerCase().trim() : p))
        : [];
      const targetAction = (actionName || "").toLowerCase().trim();

      if (actionPerms.includes(targetAction) || actionPerms.includes("*")) {
        return next();
      }

      // Fallback: check role defaults
      const roleDefaults = ROLE_ACTION_DEFAULTS[role] || [];
      if (roleDefaults.includes(targetAction) || roleDefaults.includes("*")) {
        return next();
      }

      return errorResponse(
        res,
        `Forbidden: You do not have permission to perform '${actionName}'.`,
        403
      );
    } catch (error) {
      console.error("[requireActionPermission]", error);
      return errorResponse(res, "Action authorization failed", 500);
    }
  };
};

/**
 * Middleware factory to check page-level permissions
 */
const requirePagePermission = (pageName, accessType = "canView") => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return errorResponse(res, "Authentication required", 401);
      }

      const role = (user.role || "").toLowerCase().trim();

      // Super Admin and Admin bypass all checks
      if (role === "super admin" || role === "admin" || user.is_super_admin || user.isSuperAdmin || user.is_Special) {
        return next();
      }

      const pagePerms = Array.isArray(user.pagePermissions) ? user.pagePermissions : [];
      const targetPage = (pageName || "").toLowerCase().trim();
      const pagePerm = pagePerms.find((p) => (p.pageName || "").toLowerCase().trim() === targetPage);

      if (pagePerm && pagePerm[accessType]) {
        return next();
      }

      return errorResponse(
        res,
        `Forbidden: You do not have '${accessType}' permission for page '${pageName}'.`,
        403
      );
    } catch (error) {
      console.error("[requirePagePermission]", error);
      return errorResponse(res, "Page authorization failed", 500);
    }
  };
};

module.exports = {
  requireSuperAdmin,
  requireActionPermission,
  requirePagePermission,
  ROLE_ACTION_DEFAULTS,
};
