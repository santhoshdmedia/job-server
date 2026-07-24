const _ = require("lodash");
const {
  INVALID_ACCOUNT_DETAILS,
  INCORRECT_PASSWORD,
  LOGIN_SUCCESS,
  PASSWORD_CHANGED_SUCCESSFULLY,
  PASSWORD_CHANGED_FAILED,
} = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { AdminUsersSchema } = require("./models_import");
const { PlaintoHash, GenerateToken, EncryptPassword } = require("../helper/shared.helper");

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await AdminUsersSchema.findOne({ email });
    if (!user) return errorResponse(res, INVALID_ACCOUNT_DETAILS);

    const isPasswordValid = await PlaintoHash(password, user.password);
    if (!isPasswordValid) return errorResponse(res, INCORRECT_PASSWORD);

    // Mark online and save
    user.isOnline = true;
    await user.save();

    const payload = { id: user._id, email: user.email, role: user.role };
    const token = await GenerateToken(payload);

    const userObj = user.toObject();
    delete userObj.password;

    return successResponse(res, LOGIN_SUCCESS, { ...userObj, token });
  } catch (err) {
    console.error("Login error:", err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};

const changePasswrod = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const userId = req.userData.id;
    const user = await AdminUsersSchema.findById(userId);
    if (!user) {
      return errorResponse(res, "User not found");
    }

    const isMatch = await PlaintoHash(oldPassword, user.password);
    if (!isMatch) {
      return errorResponse(res, INCORRECT_PASSWORD);
    }

    user.password = await EncryptPassword(newPassword);
    await user.save();
    return successResponse(res, PASSWORD_CHANGED_SUCCESSFULLY);
  } catch (err) {
    console.log(err);
    return errorResponse(res, PASSWORD_CHANGED_FAILED);
  }
};

const checkloginstatus = async (req, res) => {
  try {
    const { id } = req.userData;

    // Use .lean() so we get a plain object; findById returns null if not found
    const result = await AdminUsersSchema.findById(id, { password: 0 }).lean();

    if (!result) {
      return res.status(200).send({ message: "Invalid Token" });
    }

    return res.status(200).send({ message: "Already Login", data: result });
  } catch (err) {
    console.log(err);
    return res.status(500).send({ message: "Server error" });
  }
};

module.exports = { login, changePasswrod, checkloginstatus };