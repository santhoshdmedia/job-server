const { Schema, model } = require("mongoose");

const pagePermissionSchema = new Schema({
  pageName: {
    type: String,
    required: true,
  },
  canView: {
    type: Boolean,
    default: false,
  },
  canEdit: {
    type: Boolean,
    default: false,
  },
  canDelete: {
    type: Boolean,
    default: false,
  },
}, { _id: false });

module.exports = model(
  "admin_users",
  Schema(
    {
      profileImg: {
        type: String,
      },
      name: {
        type: String,
        required: true,
      },
      email: {
        type: String,
        required: true,
        unique: true,
      },
      phone: {
        type: Number,
        required: true,
      },
      password: {
        type: String,
        required: true,
      },
      role: {
        type: String,
        enum: [
          "super admin",
          "Frontend admin",
          "Backend admin",
          "accounting team",
          "designing team",
          "quality check",
          "production team",
          "packing team",
          "delivery team",
        ],
        required: true,
      },
      pagePermissions: [pagePermissionSchema],
      available: {
        type: Boolean,
        default: true,
      },
      isOnline: {
        type: Boolean,
        default: false,
      },
    },
    {
      collection: "admin users",
      timestamps: true,
    }
  )
);