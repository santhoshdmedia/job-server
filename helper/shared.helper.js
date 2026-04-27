const bycrpt = require("bcrypt");
const jwt = require("jsonwebtoken");
const _ = require("lodash");
const { model } = require("mongoose");
const { errorResponse, successResponse } = require("../helper/response.helper");



const PlaintoHash = async (plain_text, hash_text) => {
  return await bycrpt.compare(plain_text, hash_text);
};

const EncryptPassword = async (password) => {
  return await bycrpt.hash(password, 12);
};

const GenerateToken = async (payload) => {
  try {
    return await jwt.sign(payload, process.env.SECRET_KEY);
  } catch (err) {
    throw err;
  }
};
// New authenticate middleware (recommended)
const authenticate = async (req, res, next) => {
  try {
    const token = _.get(req, "headers.authorization", "");
    
    if (!token) {
      return errorResponse(res, "Access denied. No token provided.", 401);
    }

    // Remove "Bearer " prefix if present
    const tokenString = token.startsWith("Bearer ") ? token.split(" ")[1] : token;
    
    const decoded = jwt.verify(tokenString, process.env.SECRET_KEY || process.env.JWT_SECRET);
    
    if (_.isEmpty(decoded)) {
      return errorResponse(res, "Invalid token", 401);
    }

    // Check if user exists and is active
    
    if (!user) {
      return errorResponse(res, "User not found", 401);
    }

    if (!user.isActive) {
      return errorResponse(res, "Account is deactivated", 401);
    }

    req.user = user;
    req.userData = decoded; // For backward compatibility
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
    } else {
      const result = await jwt.verify(token.split(" ")[1], process.env.SECRET_KEY);

      if (_.isEmpty(result)) {
        return res.status(401).send({ message: "Invalid token" });
      }
      req.userData = result;      
      next();
    }
    return false;
  } catch (err) {
    console.error("Error verifying token:", err);
  }
};

module.exports = { PlaintoHash, EncryptPassword, GenerateToken, VerfiyToken,authenticate };
