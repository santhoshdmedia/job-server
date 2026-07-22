/**
 * Job Routes v2 (FIXED)
 * - All endpoints for job management
 * - Design file upload and management
 * - Session tracking
 */

const express = require("express");
const router = express.Router();
const jobController = require("../controller/Job.controller");
const material = require("../controller/Material_issue.controller");
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
// ✅ Open to any designer — uploading is always allowed.
router.post("/:id/items/:itemId/design-files", jobController.addItemDesignFiles);

// Remove design file
router.delete("/:id/items/:itemId/design-files/:fileId", jobController.removeItemDesignFile);

// Assign designer to file (initial assignment)
router.post("/:id/approve",  jobController.approveJob);
router.post("/:id/assign",  jobController.assignJob);
router.patch("/:id/items/:itemId/design-files/:fileId/assign", jobController.assignDesignFile);
router.post("/:id/items/:itemId/design-file/migrate", jobController.migrateDesignFile);

// ✅ NEW — Re-assign an already-assigned file to a different designer, or
// to "Outsource". Admin/superadmin only. Does not remove or replace the
// `/assign` route above — both remain available.
router.patch("/:id/items/:itemId/design-files/:fileId/reassign", jobController.reassignDesignFile);

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

router.get("/assigned-to/:userId", jobController.getJobsAssignedToUser);

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY CHECK
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/qc/update", jobController.updateQC);
router.post("/:id/qc/pass", jobController.passQC);
router.post("/:id/qc/fail", jobController.failQC);


// payment endpoints (legacy, to be refactored later)
router.post("/:id/collect-payment", jobController.collectPayment);


// POST /api/jobs/upload - Upload file to S3
// Used by frontend to upload design files before adding to job
router.post("/upload", upload.single("image"), validateFileMiddleware, async (req, res) => {
  const { UploadImage } = require("../helpers/upload.helper");
  return UploadImage(req, res);
});

router.post("/:jobId/material/issue", material.issueMaterial);

// GET /api/jobs/:jobId/material
// Job-scoped material issues — used by the production panel to match each
// cart item's design files to their issued material (cart_item_index /
// design_file_id), mirroring the store manager's per-design-file logic.
// This was previously implemented in the controller (getJobMaterials) but
// never mounted, forcing the frontend to fetch the unfiltered/paginated
// global `/material` list and filter client-side. Mounting it here fixes
// that and gives production an accurate, job-scoped source of truth.
router.get("/:jobId/material", material.getJobMaterials);

// GET /api/jobs/:jobId/items/:itemId/material
router.get("/:jobId/items/:itemId/material", material.getItemMaterials);
  
module.exports = router;