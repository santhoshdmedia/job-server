const mongoose = require("mongoose");

/**
 * Global sequence counter.
 * One single document (key: "product_code") holds the running sequence
 * number used for ALL product codes, regardless of unit type, brand,
 * or product name. The sequence NEVER resets and NEVER goes backwards.
 */
const counterSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true, unique: true },
    value: { type: Number, default: 0 },
  },
  { collection: "counter", timestamps: true }
);

module.exports = mongoose.model("counter", counterSchema);