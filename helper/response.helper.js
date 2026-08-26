const SOMETING_WENT_WRONG = require("../helper/message.helper");

const successResponse = (res, message = "", data = []) => {
  return res.status(200).send({ message: message, data: data });
};

const errorResponse = (res, message = SOMETING_WENT_WRONG, statusCode = 500) => {
  return res.status(statusCode).send({ message: message });
};

module.exports = { errorResponse, successResponse };
