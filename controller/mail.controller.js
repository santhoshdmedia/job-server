const { errorResponse, successResponse } = require("../helper/response.helper");
const { sendMail, sendMailresetLink } = require("../mail/sendMail");
const { UserSchema, ResetPasswordSchema } = require("./models_import");
const crypto = require("crypto");
// const { v4: uuidv4 } = require("uuid");
const CUSTOMER_URL = process.env.CUSTOMER_SIDE_URL;
const _ = require("lodash");
const { EncryptPassword } = require("../helper/shared.helper");
const { log } = require("console");
const { SOMETHING_WENT_WRONG, PASSWORD_CHANGED_SUCCESSFULLY } = require("../helper/message.helper");

const sendForgetPasswordMail = async (req, res) => {
  try {
    const { mail_id } = req.body;

    if (!mail_id) {
      return errorResponse(res, "Email is required");
    }

    const user = await UserSchema.findOne({ email: mail_id });

    if (!user) {
      return errorResponse(res, "Account not found");
    }

    const resetToken = crypto.randomBytes(20).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ResetPasswordSchema.create({
      user_id: user._id,
      reset_link: resetToken,
      expiresAt: expiresAt,
    });

    const resetLink = `${CUSTOMER_URL}/${resetToken}`;

    const emailData = {
      email: user.email,
      name: user.name,
      url: resetLink,
      target: "reset password",
    };

    try {
      await sendMail(emailData);
      return successResponse(res, "Password reset email sent successfully");
    } catch (err) {
      console.log(err);
      return errorResponse(res, "Failed to send email");
    }
  } catch (err) {
    console.log(err);
    return errorResponse(err, "Server Error");
  }
};
const sendDealerPasswordMail = async (req, res) => {
  try {
    const { mail_id } = req.body;

    if (!mail_id) {
      return errorResponse(res, "Email is required");
    }

    const user = await UserSchema.findOne({ email: mail_id });

    if (!user) {
      return errorResponse(res, "Account not found");
    }

    const resetToken = crypto.randomBytes(20).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ResetPasswordSchema.create({
      user_id: user._id,
      reset_link: resetToken,
      expiresAt: expiresAt,
    });

    const resetLink = `${CUSTOMER_URL}/${resetToken}`;

    const emailData = {
      email: user.email,
      name: user.name,
      url: resetLink,
      target: "Verify user",
    };

    try {
      await sendMail(emailData);
      return successResponse(res, "Password reset email sent successfully");
    } catch (err) {
      console.log(err);
      return errorResponse(res, "Failed to send email");
    }
  } catch (err) {
    console.log(err);
    return errorResponse(err, "Server Error");
  }
};

const verfiyLink = async (req, res) => {
  try {
    const { id } = req.params;

    const verification_result = await ResetPasswordSchema.aggregate([
      {
        $match: {
          reset_link: id,
          expiresAt: { $gt: new Date() },
        },
      },
    ]);

    if (_.isEmpty(verification_result)) {
      return successResponse(res, "send success", { result: false });
    }

    return successResponse(res, "", { result: true });
  } catch (err) {
    console.log(err);
    return errorResponse(res, "Something Went Wrong");
  }
};

const resetPassword = async (req, res) => {
  try {
    const { reset_url, password } = req.body;

    const { user_id } = await ResetPasswordSchema.findOne({
      reset_link: reset_url,
    });

    const hashedPassword = await EncryptPassword(password);

    const result = await UserSchema.findByIdAndUpdate(user_id, { password: hashedPassword }, { new: true });

    return successResponse(res, PASSWORD_CHANGED_SUCCESSFULLY);
  } catch (err) {
    console.log(err);
    return errorResponse(res, SOMETHING_WENT_WRONG);
  }
};



module.exports = {
  sendForgetPasswordMail,
  sendDealerPasswordMail,
  verfiyLink,
  resetPassword,
};
