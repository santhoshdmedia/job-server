const _ = require("lodash");
const {
  INVALID_ACCOUNT_DETAILS,
  INCORRECT_PASSWORD,
  LOGIN_SUCCESS,
  PASSWORD_CHANGED_SUCCESSFULLY,
  SIGNUP_SUCCESS,
  PASSWORD_CHANGED_FAILED,
  CLIENT_USERS_GETTING_SUCESS,
  CLIENT_USERS_GETTING_FAILED,
  CLIENT_USER_UPDATED_SUCCESS,
  CLIENT_USER_UPDATED_FAILED,
  CLIENT_USER_DELETED_SUCCESS,
  CLIENT_USER_DELETED_FAILED,
  CLIENT_USER_ACCOUNT_ALREADY_EXISTS,
} = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { UserSchema } = require("./models_import");
const { PlaintoHash, GenerateToken, EncryptPassword } = require("../helper/shared.helper");
const { default: mongoose } = require("mongoose");
const { sendMail } = require("../mail/sendMail");

// ─── Client Login ─────────────────────────────────────────────────────────────
// BUG FIX: Was using aggregate() (returns array) then checking `if (!user)`
// which is always falsy for an array. Switched to findOne() for a plain doc.
const clientLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await UserSchema.findOne({ email });
    if (!user) {
      return errorResponse(res, INVALID_ACCOUNT_DETAILS);
    }

    const isPasswordValid = await PlaintoHash(password, user.password || "");
    if (!isPasswordValid) {
      return errorResponse(res, INCORRECT_PASSWORD);
    }

    const payload = {
      id: user._id,
      email: user.email,
      role: user.role,
    };
    const token = await GenerateToken(payload);

    const userObj = user.toObject();
    delete userObj.password;

    return successResponse(res, LOGIN_SUCCESS, { ...userObj, token });
  } catch (err) {
    console.error("clientLogin error:", err);
    return errorResponse(res, "An error occurred while logging in");
  }
};

// ─── Google Login ─────────────────────────────────────────────────────────────
const clientgoogleLogin = async (req, res) => {
  try {
    const { googleId, name, email, picture } = req.body;

    if (!googleId || !email) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields (googleId or email)",
      });
    }

    let user = await UserSchema.findOne({ $or: [{ googleId }, { email }] });

    if (user) {
      if (!user.googleId) {
        user.googleId = googleId;
        user.name = name || user.name;
        if (!user.picture && picture) user.picture = picture;
        await user.save();
      }
    } else {
      user = new UserSchema({
        googleId,
        name,
        email,
        picture,
        role: "user",
        wish_list: [],
      });
      await user.save();
    }

    const payload = {
      id: user._id.toString(),
      email: user.email,
      role: user.role || "user",
    };
    const token = await GenerateToken(payload);

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id.toString(),
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        picture: user.picture,
        role: user.role || "user",
        wish_list: user.wish_list || [],
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

// ─── Email (magic-link style) Login ──────────────────────────────────────────
// BUG FIX: Was calling _.get(user, "[0]._id") on a plain Mongoose doc (not array),
// producing empty string in JWT. Now uses user._id directly.
const clientEmailLogin = async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let user = await UserSchema.findOne({ email });

    if (user) {
      if (!user.name) {
        user.name = name;
        await user.save();
      }
    } else {
      user = new UserSchema({ name, email });
      await user.save();
    }

    // FIX: user is a plain document, not an array — access fields directly
    const payload = {
      id: user._id,
      email: user.email,
      role: user.role,
    };
    const token = await GenerateToken(payload);

    return res.status(200).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("clientEmailLogin error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── Custom Signup ────────────────────────────────────────────────────────────
const customSignup = async (req, res) => {
  const { email, password, name, unique_code, businessName, role, phone } = req.body;

  if (!email || !password || !name) {
    return errorResponse(res, "Missing required fields: email, password, name");
  }

  const validRoles = ["user", "Corporate", "Dealer"];
  if (role && !validRoles.includes(role)) {
    return errorResponse(res, "Invalid role specified");
  }

  try {
    const existingUser = await UserSchema.findOne({
      email: email.toLowerCase().trim(),
    });
    if (existingUser) {
      return errorResponse(res, CLIENT_USER_ACCOUNT_ALREADY_EXISTS);
    }

    const newUser = new UserSchema({
      email: email.toLowerCase().trim(),
      password: await EncryptPassword(password),
      name: name.trim(),
      phone,
      role,
      ...(unique_code && { unique_code }),
      ...(businessName && { businessName }),
    });

    const savedUser = await newUser.save();

    const payload = {
      id: savedUser._id,
      email: savedUser.email,
      role: savedUser.role,
      ...(savedUser.business_name && { business_name: savedUser.business_name }),
      ...(savedUser.unique_code && { unique_code: savedUser.unique_code }),
    };
    const token = await GenerateToken(payload);

    const userResponse = _.omit(savedUser.toObject(), "password");
    return successResponse(res, SIGNUP_SUCCESS, { ...userResponse, token });
  } catch (error) {
    console.error("Signup Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "Account already exists with this email");
    }
    if (error.name === "ValidationError") {
      return errorResponse(res, "Validation failed. Please check your input.");
    }
    return errorResponse(res, "An error occurred during signup");
  }
};

// ─── BNI Signup ───────────────────────────────────────────────────────────────
const BNISignup = async (req, res) => {
  const {
    email,
    password,
    name,
    unique_code,
    businessName,
    role = "bni_user",
    phone,
    member_Name,
    chapter_Name,
    city,
    categorey,
  } = req.body;

  if (!email || !password || !name) {
    return errorResponse(res, "Missing required fields: email, password, name");
  }

  const validRoles = ["bni_user"];
  if (role && !validRoles.includes(role)) {
    return errorResponse(res, "Invalid role specified");
  }

  try {
    const existingUser = await UserSchema.findOne({
      email: email.toLowerCase().trim(),
    });
    if (existingUser) {
      return errorResponse(res, CLIENT_USER_ACCOUNT_ALREADY_EXISTS);
    }

    const newUser = new UserSchema({
      email: email.toLowerCase().trim(),
      password: await EncryptPassword(password),
      name: name.trim(),
      phone,
      role,
      ...(unique_code && { unique_code }),
      ...(businessName && { businessName }),
      member_Name,
      chapter_Name,
      city,
      categorey,
    });

    const savedUser = await newUser.save();

    const payload = {
      id: savedUser._id,
      email: savedUser.email,
      role: savedUser.role,
      ...(savedUser.businessName && { businessName: savedUser.businessName }),
      ...(savedUser.unique_code && { unique_code: savedUser.unique_code }),
      member_Name: savedUser.member_Name,
      chapter_Name: savedUser.chapter_Name,
      city: savedUser.city,
      categorey: savedUser.categorey,
    };
    const token = await GenerateToken(payload);

    const emailData = {
      email: savedUser.email,
      name: member_Name || name,
      target: "BNI welcome mail",
    };
    sendMail(emailData).catch((err) => console.error("Failed to send welcome email:", err));

    const userResponse = _.omit(savedUser.toObject(), "password");
    return successResponse(res, SIGNUP_SUCCESS, { ...userResponse, token });
  } catch (error) {
    console.error("BNISignup Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "Account already exists with this email");
    }
    if (error.name === "ValidationError") {
      return errorResponse(res, "Validation failed. Please check your input.");
    }
    return errorResponse(res, "An error occurred during signup");
  }
};

// ─── Verify Test ──────────────────────────────────────────────────────────────
const userVerifyTest = async (req, res) => {
  const { name, email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email is required" });
  }

  const emailData = {
    email,
    name: name || "Test User",
    target: "Verify user",
  };

  try {
    await sendMail(emailData);
    return res.json({ success: true, message: "Test email sent", debug: { email } });
  } catch (err) {
    console.error("Test email error:", err);
    return res.status(500).json({ error: "Failed to send email", details: err.message });
  }
};

// ─── Client Signup (legacy) ───────────────────────────────────────────────────
const clientSignup = async (req, res) => {
  const { email, password, name, phone, gst_no } = req.body;
  try {
    const result = await UserSchema.findOne({ email });
    if (result) {
      return errorResponse(res, CLIENT_USER_ACCOUNT_ALREADY_EXISTS);
    }

    const newUser = new UserSchema({
      email,
      password: await EncryptPassword(password),
      name,
      phone,
      gst_no,
    });
    const user = await newUser.save();

    const payload = {
      id: user._id,
      email: user.email,
      role: user.role,
      phone: user.phone,
    };
    const token = await GenerateToken(payload);

    const userObj = user.toObject();
    delete userObj.password;
    return successResponse(res, SIGNUP_SUCCESS, { ...userObj, token });
  } catch (error) {
    console.log(error);
    return errorResponse(res, "An error occurred while sign in");
  }
};

// ─── Get All Client Users ─────────────────────────────────────────────────────
const getAllClientUsers = async (req, res) => {
  try {
    const { limit } = JSON.parse(_.get(req, "params.id", "{}"));
    const result = await UserSchema.aggregate([
      { $match: { role: "user" } },
      ...(limit ? [{ $limit: 5 }] : []),
    ]);
    return successResponse(res, CLIENT_USERS_GETTING_SUCESS, result);
  } catch (error) {
    console.log(error);
    return errorResponse(res, CLIENT_USERS_GETTING_FAILED);
  }
};

// ─── Get All Custom Users ─────────────────────────────────────────────────────
const getAllCustomUsers = async (req, res) => {
  try {
    const result = await UserSchema.aggregate([
      { $match: { role: { $ne: "user" } } },
    ]);
    return successResponse(res, CLIENT_USERS_GETTING_SUCESS, result);
  } catch (error) {
    console.log(error);
    return errorResponse(res, CLIENT_USERS_GETTING_FAILED);
  }
};

// ─── Get Single Client ────────────────────────────────────────────────────────
const getSingleClient = async (req, res) => {
  try {
    const { _id } = JSON.parse(req.params.id);

    let where = {};
    if (_id) {
      where._id = new mongoose.Types.ObjectId(_id);
    }

    const result = await UserSchema.aggregate([
      { $match: where },
      { $project: { password: 0 } },
      { $sort: { createdAt: -1 } },
      {
        $lookup: {
          from: "order_details",
          as: "order_details",
          localField: "_id",
          foreignField: "user_id",
          pipeline: [
            {
              $lookup: {
                from: "order_delivery_timeline",
                as: "order_delivery_timeline",
                localField: "_id",
                foreignField: "order_id",
              },
            },
          ],
        },
      },
      {
        $lookup: {
          from: "user_review",
          as: "review_details",
          localField: "_id",
          foreignField: "user_id",
          pipeline: [
            {
              $lookup: {
                from: "product",
                as: "product_details",
                localField: "product_id",
                foreignField: "_id",
              },
            },
          ],
        },
      },
    ]);

    return successResponse(res, "Get Success", result);
  } catch (err) {
    console.log(err);
    return errorResponse(res, "Failed to get client");
  }
};

// ─── Update Client User ───────────────────────────────────────────────────────
// BUG FIX: password update is correctly handled — encrypts before saving.
const updateClientUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const { id } = req.params;

    // Check email uniqueness against other users
    if (email) {
      const duplicate = await UserSchema.findOne({
        email,
        _id: { $ne: id },
      });
      if (duplicate) {
        return errorResponse(res, CLIENT_USER_ACCOUNT_ALREADY_EXISTS);
      }
    }

    // Encrypt password if being changed
    if (password) {
      req.body.password = await EncryptPassword(password);
    }

    const user = await UserSchema.findByIdAndUpdate(id, req.body, { new: true });
    if (!user) {
      return errorResponse(res, "User not found");
    }

    const userObj = user.toObject();
    delete userObj.password;
    return successResponse(res, CLIENT_USER_UPDATED_SUCCESS, userObj);
  } catch (err) {
    console.log(err);
    return errorResponse(res, CLIENT_USER_UPDATED_FAILED);
  }
};

// ─── Delete Client User ───────────────────────────────────────────────────────
const deleteClientUser = async (req, res) => {
  try {
    const { id } = req.userData;
    const user = await UserSchema.findById(id);

    const { password } = req.body;
    const isPasswordValid = await PlaintoHash(password, _.get(user, "password", ""));
    if (isPasswordValid) {
      await UserSchema.findByIdAndDelete(id);
      return successResponse(res, CLIENT_USER_DELETED_SUCCESS);
    } else {
      return errorResponse(res, INCORRECT_PASSWORD);
    }
  } catch (err) {
    console.log(err);
    return errorResponse(res, CLIENT_USER_DELETED_FAILED);
  }
};

// ─── Client Check Login Status ────────────────────────────────────────────────
// BUG FIX: _.isEmpty() on a Mongoose document is unreliable.
// Use findById + lean() and check for null directly.
const clientCheckloginstatus = async (req, res) => {
  try {
    const { id } = req.userData;

    const result = await UserSchema.findById(id, { password: 0 }).lean();

    if (!result) {
      return res.status(200).send({ message: "Invalid Token" });
    }
    return res.status(200).send({ message: "Already Login", data: result });
  } catch (err) {
    console.log(err);
    return res.status(500).send({ message: "Server error" });
  }
};

// ─── Add to History ───────────────────────────────────────────────────────────
const addtoHistory = async (req, res) => {
  try {
    const result = await UserSchema.findOne({
      history_data: { $in: [req.body.product_id] },
    });
    if (result) return res.status(200).json({ success: true });

    await UserSchema.findByIdAndUpdate(req.userData.id, {
      $push: { history_data: req.body.product_id },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to add to history" });
  }
};

module.exports = {
  clientLogin,
  clientSignup,
  customSignup,
  getAllCustomUsers,
  clientCheckloginstatus,
  getAllClientUsers,
  updateClientUser,
  deleteClientUser,
  getSingleClient,
  addtoHistory,
  clientgoogleLogin,
  BNISignup,
  userVerifyTest,
  clientEmailLogin,
};