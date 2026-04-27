const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const filepath = require("path");
const _ = require("lodash");
const { successResponse,errorResponse } = require("../helper/response.helper");
require("dotenv").config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,  // Fixed variable name
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});


const UploadImage = async (req, res) => {
  try {
    // Validate required fields
    if (!req.file) {
      return errorResponse(res, "No file uploaded");
    }

    // Generate unique file name
    const fileExtension = require('path').extname(req.file.originalname);
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}${fileExtension}`;

    const params = {
      Bucket: process.env.AWS_BUCKET,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype, // Important for proper MIME type detection
      //ACL: "public-read", // Uncomment if you need public access
    };

    // Upload to S3
    const command = new PutObjectCommand(params);
    await s3Client.send(command);

    // Generate the URL
    const fileUrl = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;
    
    successResponse(res, "Upload Successful", { 
      url: fileUrl,
      fileName: fileName
    });

  } catch (err) {
    console.error("S3 Upload Error:", err);
    errorResponse(res, "File upload failed: " + err.message);
  }
};
module.exports = { UploadImage };
