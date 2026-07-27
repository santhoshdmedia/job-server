const _ = require("lodash");
const { INVALID_ACCOUNT_DETAILS, INCORRECT_PASSWORD, LOGIN_SUCCESS, PASSWORD_CHANGED_SUCCESSFULLY, SIGNUP_SUCCESS, PASSWORD_CHANGED_FAILED } = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { AdminUsersSchema, UserSchema } = require("./models_import");
const { PlaintoHash, GenerateToken, EncryptPassword } = require("../helper/shared.helper");
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("1. Body received:", { email, password }); // ← add

    const user = await AdminUsersSchema.findOne({ email });
    console.log("2. User found:", user ? "yes" : "no"); // ← add

    if (!user) return errorResponse(res, INVALID_ACCOUNT_DETAILS);

    const isPasswordValid = await PlaintoHash(password, user.password);
    console.log("3. Password valid:", isPasswordValid); // ← add

    if (!isPasswordValid) return errorResponse(res, INCORRECT_PASSWORD);

    user.isOnline = true;
    await user.save();

    const payload = { id: user._id, email: user.email, role: user.role };
    const token = await GenerateToken(payload);
    console.log("4. Token generated:", token ? "yes" : "no"); // ← add

    const userObj = user.toObject();
    delete userObj.password;

    return successResponse(res, LOGIN_SUCCESS, { ...userObj, token });
  } catch (err) {
    console.error("Login FULL error:", err.message); // ← change this
    console.error("Login STACK:", err.stack);        // ← add this
    return res.status(500).json({ error: err.message }); // ← return real error
  }
};

const changePasswrod = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const userId = req.userData.id;
    const user = await AdminUsersSchema.findOne({ _id: userId });
    if (!user) {
      return errorResponse(res, "user not found");
    }
    const isMatch = await PlaintoHash(oldPassword, user.password);
    if (!isMatch) {
      return errorResponse(res, INCORRECT_PASSWORD);
    }

    const hashPassword = await EncryptPassword(newPassword);
    user.password = hashPassword;
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

    const result = await AdminUsersSchema.findOne({ _id: id }, { password: 0 });
    result.isOnline=true;

    if (_.isEmpty(result)) {
      return res.status(200).send({ message: "Invalid Token" });
    }
    return res.status(200).send({ message: "Already Login", data: result });
  } catch (err) {
    console.log(err);
    return res.status(500).send({ message: "Server error" });
  }
};

module.exports = { login, changePasswrod, checkloginstatus };
