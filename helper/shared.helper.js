const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const { errorResponse, successResponse } = require("../helper/response.helper");
const { AdminUsersSchema } = require("../controller/models_import"); // adjust path

const PlaintoHash = async (plain_text, hash_text) => {
  return await bcrypt.compare(plain_text, hash_text);
};

const EncryptPassword = async (password) => {
  return await bcrypt.hash(password, 12);
};

const GenerateToken = async (payload) => {
  return jwt.sign(payload, process.env.SECRET_KEY);
};

// ✅ Fixed authenticate middleware
const authenticate = async (req, res, next) => {
  try {
    const token = _.get(req, "headers.authorization", "");

    if (!token) {
      return errorResponse(res, "Access denied. No token provided.", 401);
    }

    const tokenString = token.startsWith("Bearer ") ? token.split(" ")[1] : token;
    const decoded = jwt.verify(tokenString, process.env.SECRET_KEY);

    if (!decoded) {
      return errorResponse(res, "Invalid token", 401);
    }

    // ✅ Actually fetch the user
    const user = await AdminUsersSchema.findById(decoded.id).lean();

    if (!user) {
      return errorResponse(res, "User not found", 401);
    }

    if (!user.isActive) {
      return errorResponse(res, "Account is deactivated", 401);
    }

    req.user = user;
    req.userData = decoded;
    next();
  } catch (error) {
    console.error("Auth error:", error);

    if (error.name === "JsonWebTokenError") {
      return errorResponse(res, "Invalid token", 401);
    }
    if (error.name === "TokenExpiredError") {
      return errorResponse(res, "Token expired", 401);
    }

    return errorResponse(res, "Authentication failed", 500);
  }
};

const VerfiyToken = async (req, res, next) => {
  try {
    const token = _.get(req, "headers.authorization", "");
    if (!token) {
      return res.status(401).send({ message: "Invalid token" });
    }

    const result = jwt.verify(token.split(" ")[1], process.env.SECRET_KEY);

    if (_.isEmpty(result)) {
      return res.status(401).send({ message: "Invalid token" });
    }

    req.userData = result;
    next();
  } catch (err) {
    console.error("Error verifying token:", err);
    return res.status(401).send({ message: "Invalid or expired token" });
  }
};

module.exports = { PlaintoHash, EncryptPassword, GenerateToken, VerfiyToken, authenticate };