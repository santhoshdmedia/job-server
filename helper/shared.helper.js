const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const { errorResponse } = require("../helper/response.helper");
const { AdminUsersSchema } = require("../controller/models_import");

const PlaintoHash = async (plain_text, hash_text) => {
  return await bcrypt.compare(plain_text, hash_text);
};

const EncryptPassword = async (password) => {
  return await bcrypt.hash(password, 12);
};

const GenerateToken = async (payload) => {
  return jwt.sign(payload, process.env.SECRET_KEY);
};

// Authenticates admin users (AdminUsersSchema).
// Checks token validity and that the user exists and is not deactivated.
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

    const user = await AdminUsersSchema.findById(decoded.id).lean();

    if (!user) {
      return errorResponse(res, "User not found", 401);
    }

    // Use `available` field (the actual field in AdminUsersSchema).
    // `isActive` does not exist — checking it would block every user.
    if (user.available === false) {
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

// General-purpose token verification (no DB lookup).
// Used for routes that only need the decoded payload (req.userData).
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