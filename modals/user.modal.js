const mongoose = require("mongoose");

// Address Schema
const addressSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobileNumber: { type: String, required: true },
  alternateMobileNumber: { type: String, require: true },
  street: { type: String, required: true },
  locality: { type: String, required: true },
  city: { type: String, required: true },
  state: { type: String, required: true },
  addressType: { type: String, required: true },
  pincode: { type: String, required: true },
});

// User Schema
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      minlength: 3,
      maxlength: 50,
      trim: true,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true // Allows null values while maintaining uniqueness for non-null values
    },
    picture: { type: String },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      minlength: 6,
    },
    gst_no: {
      type: String,
    },
    business_name: {
      type: String,
    },
    business_phone: {
      type: String,
    },
    business_email: {
      type: String,
    },
    business_address: {
      type: String,
    },
    person_address: {
      type: String,
    },
    person_phone: {
      type: String,
    },
    role: {
      type: String,
      default: "user",
      enum: ["user", "Corporate", "Dealer","bni_user"],
    },
    member_Name: {
      type: String,
    },
    chapter_Name: {
      type: String,
    },
    city: {
      type: String,
    },
    categorey: {
      type: String,
    },
    phone: {
      type: Number
    },
    redeemedRewards: [{
      rewardId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reward'
      },
      redeemedAt: {
        type: Date,
        default: Date.now
      },
      pointsSpent: Number,
      status: {
        type: String,
        enum: ['pending', 'shipped', 'delivered', 'cancelled'],
        default: 'pending'
      }
    }],
    Dealer_verification: {
      type: Boolean,
      default: false,
    },
    verified_at: {
      type: Date,
    },
    verified_by: {
      type: mongoose.Schema.Types.ObjectId,
        ref: 'admin users'
    },
    Dealer_verification: {
      type: Boolean,
      default: false,
    },
    wish_list: [], 
    history_data: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "product",
      },
    ],

    addresses: [addressSchema],
    unique_code: {
      type: String,
    },
    businessName: {
      type: String,
    }
  },
  {
    timestamps: true,
    collection: "user",
  }
);

module.exports = mongoose.model("User", userSchema);
