const { model, Schema } = require("mongoose");

module.exports = model(
  "resetPassword",
  Schema(
    {
      user_id: {
        type: Schema.Types.ObjectId,
        ref: "user",
        required: true,
      },
      reset_link: {
        type: String,
        required: true,
        unique: true,
      },
      expiresAt: {
        type: Date,
        required: true,
      },
    },
    {
      collection: "resetPassword",
      timestamps: true,
    }
  )
);
