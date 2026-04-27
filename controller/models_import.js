// ==================== MODELS IMPORT ====================
// File: controller/models_import.js

const User                = require("../modals/user.modal");
const AdminUsers          = require("../modals/adminusers.modals");
const resetPasswordModals = require("../modals/resetPassword.modals");
const ProductSchema       = require("../modals/product.models");

module.exports = {
  UserSchema:                  User,
  AdminUsersSchema:            AdminUsers,
  ResetPasswordSchema:         resetPasswordModals,
  ProductSchema:              ProductSchema,
};