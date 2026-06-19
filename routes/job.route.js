/**
 * Job Routes v2 (FIXED)
 * - All endpoints for job management
 * - Design file upload and management
 * - Session tracking
 */

const express = require("express");
const router = express.Router();
const jobController = require("../controller/Job.controller");
const { upload, validateFileMiddleware } = require("../controller/shared.controller");
// const { authMiddleware } = require("../");

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────
// router.use(authMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// JOB CRUD OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

// Create job
router.post("/", jobController.createJob);

// Get all jobs
router.get("/", jobController.getAllJobs);

// Get single job
router.get("/:id", jobController.getJobById);

// Update job
router.put("/:id", jobController.updateJob);

// Update job status
router.patch("/:id/status", jobController.updateJobStatus);

// Delete job (soft delete)
router.delete("/:id", jobController.deleteJob);

// Restore job
router.patch("/:id/restore", jobController.restoreJob);

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Open session (start work)
router.post("/:id/session/open", jobController.openSession);

// Close session (pause/complete work)
router.post("/:id/session/close", jobController.closeSession);

// Get session status
router.get("/:id/session/status", jobController.getSessionStatus);

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN FILE MANAGEMENT (NEW/FIXED)
// ─────────────────────────────────────────────────────────────────────────────

// Add design files to item (supports file assignment)
router.post("/:id/items/:itemId/design-files", jobController.addItemDesignFiles);

// Remove design file
router.delete("/:id/items/:itemId/design-files/:fileId", jobController.removeItemDesignFile);

// Assign designer to file
router.post("/:id/approve",  jobController.approveJob);
router.patch("/:id/items/:itemId/design-files/:fileId/assign", jobController.assignDesignFile);

// Update file work status
router.patch("/:id/items/:itemId/design-files/:fileId/status", jobController.updateFileWorkStatus);

// Approve single file
router.post("/:id/items/:itemId/design-files/:fileId/approve", jobController.approveDesignFile);

// Reject single file
router.post("/:id/items/:itemId/design-files/:fileId/reject", jobController.rejectDesignFile);

// ─────────────────────────────────────────────────────────────────────────────
// ITEM DESIGN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Approve entire item design
router.post("/:id/items/:itemId/approve-design", jobController.approveItemDesign);

// Reject entire item design
router.post("/:id/items/:itemId/reject-design", jobController.rejectItemDesign);

// Get design summary
router.get("/:id/design-summary", jobController.getDesignSummary);

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY DESIGN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Upload design (job-level)
router.post("/:id/upload_design", jobController.uploadDesign);

// ─────────────────────────────────────────────────────────────────────────────
// FILE UPLOAD ENDPOINT (NEW)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/jobs/upload - Upload file to S3
// Used by frontend to upload design files before adding to job
router.post("/upload", upload.single("image"), validateFileMiddleware, async (req, res) => {
  const { UploadImage } = require("../helpers/upload.helper");
  return UploadImage(req, res);
});

module.exports = router;