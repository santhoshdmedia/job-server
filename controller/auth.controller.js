const _ = require("lodash");
const { INVALID_ACCOUNT_DETAILS, INCORRECT_PASSWORD, LOGIN_SUCCESS, PASSWORD_CHANGED_SUCCESSFULLY, SIGNUP_SUCCESS, PASSWORD_CHANGED_FAILED } = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { AdminUsersSchema, UserSchema } = require("./models_import");
const { PlaintoHash, GenerateToken, EncryptPassword } = require("../helper/shared.helper");
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Use findOne instead of aggregate for simplicity
    const user = await AdminUsersSchema.findOne({ email });

    if (!user) {
      return errorResponse(res, INVALID_ACCOUNT_DETAILS);
    }

    const isPasswordValid = await PlaintoHash(password, user.password);

    if (!isPasswordValid) {
      return errorResponse(res, INCORRECT_PASSWORD);
    }

    // Update online status (but don't save yet – or save if you want)
    user.isOnline = true;
    await user.save(); // optional

    const payload = {
      id: user._id,
      email: user.email,
      role: user.role,
    };
    const token = await GenerateToken(payload);

    // Convert user to object and remove sensitive fields
    const userObj = user.toObject();
    delete userObj.password;

    return successResponse(res, LOGIN_SUCCESS, {
      ...userObj,
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    return errorResponse(res, "An error occurred while logging in");
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
