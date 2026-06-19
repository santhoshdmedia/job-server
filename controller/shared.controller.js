// const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
// const filepath = require("path");
// const _ = require("lodash");
// const { successResponse,errorResponse } = require("../helper/response.helper");
// require("dotenv").config();

// const s3Client = new S3Client({
//   region: process.env.AWS_REGION,
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID,  // Fixed variable name
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
//   },
// });


// const UploadImage = async (req, res) => {
//   try {
//     // Validate required fields
//     if (!req.file) {
//       return errorResponse(res, "No file uploaded");
//     }

//     // Generate unique file name
//     const fileExtension = require('path').extname(req.file.originalname);
//     const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}${fileExtension}`;

//     const params = {
//       Bucket: process.env.AWS_BUCKET,
//       Key: fileName,
//       Body: req.file.buffer,
//       ContentType: req.file.mimetype, // Important for proper MIME type detection
//       //ACL: "public-read", // Uncomment if you need public access
//     };

//     // Upload to S3
//     const command = new PutObjectCommand(params);
//     await s3Client.send(command);

//     // Generate the URL
//     const fileUrl = `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${params.Key}`;
    
//     successResponse(res, "Upload Successful", { 
//       url: fileUrl,
//       fileName: fileName
//     });

//   } catch (err) {
//     console.error("S3 Upload Error:", err);
//     errorResponse(res, "File upload failed: " + err.message);
//   }
// };

/**
 * Upload Helper v2 (FIXED)
 * - Supports all file types (PDF, JPG, PNG, etc.)
 * - Proper S3 configuration
 * - Better error handling and logging
 * - CORS compatible
 */

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
require("dotenv").config();

// ─────────────────────────────────────────────────────────────────────────────
// Initialize S3 Client
// ─────────────────────────────────────────────────────────────────────────────
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Supported MIME Types
// ─────────────────────────────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = {
  "image/jpeg": { ext: "jpg", name: "JPEG" },
  "image/jpg": { ext: "jpg", name: "JPG" },
  "image/png": { ext: "png", name: "PNG" },
  "image/webp": { ext: "webp", name: "WEBP" },
  "application/pdf": { ext: "pdf", name: "PDF" },
  "application/vnd.corel.document": { ext: "cdr", name: "CDR" },
  "application/dxf": { ext: "dxf", name: "DXF" },
  "text/plain": { ext: "txt", name: "TXT" },
};

const ALLOWED_EXTENSIONS = {
  jpg: { mime: "image/jpeg", name: "JPG" },
  jpeg: { mime: "image/jpeg", name: "JPEG" },
  png: { mime: "image/png", name: "PNG" },
  webp: { mime: "image/webp", name: "WEBP" },
  pdf: { mime: "application/pdf", name: "PDF" },
  cdr: { mime: "application/vnd.corel.document", name: "CDR" },
  dxf: { mime: "application/dxf", name: "DXF" },
  txt: { mime: "text/plain", name: "TXT" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Validate File
// ─────────────────────────────────────────────────────────────────────────────
const validateFile = (file) => {
  if (!file) throw new Error("No file provided");

  const { originalname, mimetype, size } = file;

  // Check file size (max 50MB)
  const MAX_SIZE = 50 * 1024 * 1024;
  if (size > MAX_SIZE) {
    throw new Error(
      `File size exceeds 50MB limit. Current size: ${Math.round(size / (1024 * 1024))}MB`,
    );
  }

  // Get extension
  const ext = path.extname(originalname).slice(1).toLowerCase();

  // Validate MIME type and extension
  const isMimeAllowed = ALLOWED_MIME_TYPES[mimetype];
  const isExtAllowed = ALLOWED_EXTENSIONS[ext];

  if (!isMimeAllowed && !isExtAllowed) {
    throw new Error(
      `Unsupported file type: ${mimetype || ext}. Allowed types: JPG, PNG, WEBP, PDF, CDR, DXF`,
    );
  }

  return {
    originalname,
    mimetype:
      mimetype || ALLOWED_EXTENSIONS[ext]?.mime || "application/octet-stream",
    size,
    ext,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Generate Unique Filename
// ─────────────────────────────────────────────────────────────────────────────
const generateFileName = (originalname, ext) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  const name = path.basename(originalname, `.${ext}`).slice(0, 30);
  return `${timestamp}-${random}-${name}.${ext}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Upload Function
// ─────────────────────────────────────────────────────────────────────────────
const UploadImage = async (req, res) => {
  let uploadedFileName = null;

  try {
    // Validate input
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. Please provide a file.",
      });
    }

    // Validate file
    const fileInfo = validateFile(req.file);
    const { originalname, mimetype, size, ext } = fileInfo;

    console.log(`📁 Upload Request | File: ${originalname} | Size: ${Math.round(size / 1024)}KB | Type: ${mimetype}`);

    // Generate unique filename
    const fileName = generateFileName(originalname, ext);
    uploadedFileName = fileName;

    // Prepare S3 params
    const s3Params = {
      Bucket: process.env.AWS_BUCKET,
      Key: `designs/${fileName}`, // Store in designs folder
      Body: req.file.buffer,
      ContentType: mimetype,
      Metadata: {
        "original-filename": originalname,
        "upload-timestamp": new Date().toISOString(),
        "uploaded-by": req.user?.id || "anonymous",
      },
    };

    console.log(`☁️  Uploading to S3 | Bucket: ${s3Params.Bucket} | Key: ${s3Params.Key}`);

    // Upload to S3
    const command = new PutObjectCommand(s3Params);
    const result = await s3Client.send(command);

    // Generate URL
    const fileUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Params.Key}`;

    console.log(`✅ Upload Success | URL: ${fileUrl}`);

    // Return success response
    return res.status(200).json({
      success: true,
      message: "File uploaded successfully",
      data: {
        url: fileUrl,
        fileName: fileName,
        originalName: originalname,
        fileType: ext.toUpperCase(),
        fileSize: size,
        fileSizeKB: Math.round(size / 1024),
        mimeType: mimetype,
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("❌ Upload Error:", {
      message: err.message,
      file: req.file?.originalname,
      uploadedFileName,
      stack: err.stack,
    });

    // Return error response
    return res.status(500).json({
      success: false,
      message:
        err.message ||
        "File upload failed. Please check the file and try again.",
      error: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: File Validation
// ─────────────────────────────────────────────────────────────────────────────
const validateFileMiddleware = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No file provided",
    });
  }

  try {
    validateFile(req.file);
    next();
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: Multer Configuration
// ─────────────────────────────────────────────────────────────────────────────
const multer = require("multer");

const storage = multer.memoryStorage(); // Store in memory before S3 upload

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const isAllowed =
    ALLOWED_MIME_TYPES[file.mimetype] || ALLOWED_EXTENSIONS[ext];

  if (isAllowed) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type: ${file.mimetype}. Allowed: JPG, PNG, WEBP, PDF, CDR, DXF`,
      ),
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

module.exports = {
  UploadImage,
  validateFileMiddleware,
  upload,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
};
