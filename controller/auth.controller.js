const _ = require("lodash");
const { INVALID_ACCOUNT_DETAILS, INCORRECT_PASSWORD, LOGIN_SUCCESS, PASSWORD_CHANGED_SUCCESSFULLY, SIGNUP_SUCCESS, PASSWORD_CHANGED_FAILED } = require("../helper/message.helper");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { AdminUsersSchema, UserSchema } = require("./models_import");
const { PlaintoHash, GenerateToken, EncryptPassword } = require("../helper/shared.helper");

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await AdminUsersSchema.aggregate([{ $match: { email } }]);
    if (!user) {
      return errorResponse(res, INVALID_ACCOUNT_DETAILS);
    }
    user.isOnline=true;

    const isPasswordValid = await PlaintoHash(password, _.get(user, "[0].password", ""));

    if (isPasswordValid) {
      const payload = {
        id: _.get(user, "[0]._id", ""),
        email: _.get(user, "[0].email", ""),
        role: _.get(user, "[0].role", ""),
      };
      const token = await GenerateToken(payload);
      return successResponse(res, LOGIN_SUCCESS, {
        ...user[0],
        token,
      });
    } else {
      return errorResponse(res, INCORRECT_PASSWORD);
    }
  } catch (err) {
    console.error(err);
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
