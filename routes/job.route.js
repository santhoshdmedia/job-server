/**
 * Job Routes - Permission-Controlled Workflow System
 */

const express = require("express");
const router = express.Router();
const jobController = require("../controller/Job.controller");
const material = require("../controller/Material_issue.controller");
const { authenticate } = require("../helper/shared.helper");
const { upload } = require("../helper/multer.helper");
const { UploadImage } = require("../controller/shared.controller");
const { requireActionPermission, requireSuperAdmin } = require("../middleware/permission.middleware");

// ═════════════════════════════════════════════════════════════════════════════
// JOB CRUD & APPROVAL OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

// Create job - Requires create_job permission
router.post("/", authenticate, requireActionPermission("create_job"), jobController.createJob);

// Get all jobs
router.get("/", jobController.getAllJobs);

// Get single job
router.get("/:id", jobController.getJobById);

// Update job
router.put("/:id", authenticate, jobController.updateJob);

// Update job status
router.patch("/:id/status", authenticate, jobController.updateJobStatus);

// Delete job (soft delete) - Admin / Super Admin only
router.delete("/:id", authenticate, requireSuperAdmin, jobController.deleteJob);

// Restore job
router.patch("/:id/restore", authenticate, requireSuperAdmin, jobController.restoreJob);

// Approve job - Only Super Admin or authorized user with approve_job permission
router.post("/:id/approve", authenticate, requireActionPermission("approve_job"), jobController.approveJob);

// ═════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

// Open session (start work)
router.post("/:id/session/open", authenticate, jobController.openSession);

// Close session (pause/complete work)
router.post("/:id/session/close", authenticate, jobController.closeSession);

// Get session status
router.get("/:id/session/status", jobController.getSessionStatus);

// ═════════════════════════════════════════════════════════════════════════════
// DESIGN FILE MANAGEMENT & ASSIGNMENT
// ═════════════════════════════════════════════════════════════════════════════

// Add design files to item
router.post("/:id/items/:itemId/design-files", authenticate, jobController.addItemDesignFiles);

// Remove design file
router.delete(
  "/:id/items/:itemId/design-files/:fileId",
  authenticate,
  jobController.removeItemDesignFile
);

// Assign designer to job / file
router.post("/:id/assign", authenticate, requireActionPermission("assign_designer"), jobController.assignJob);
router.patch(
  "/:id/items/:itemId/design-files/:fileId/assign",
  authenticate,
  requireActionPermission("assign_designer"),
  jobController.assignDesignFile
);
router.post(
  "/:id/items/:itemId/design-file/migrate",
  authenticate,
  jobController.migrateDesignFile
);

// Re-assign design file
router.patch(
  "/:id/items/:itemId/design-files/:fileId/reassign",
  authenticate,
  requireActionPermission("assign_designer"),
  jobController.reassignDesignFile
);

// Update file work status
router.patch(
  "/:id/items/:itemId/design-files/:fileId/status",
  authenticate,
  jobController.updateFileWorkStatus
);

// Approve single design file
router.post(
  "/:id/items/:itemId/design-files/:fileId/approve",
  authenticate,
  requireActionPermission("approve_design"),
  jobController.approveDesignFile
);

// Reject single design file
router.post(
  "/:id/items/:itemId/design-files/:fileId/reject",
  authenticate,
  requireActionPermission("approve_design"),
  jobController.rejectDesignFile
);

// Approve entire item design
router.post(
  "/:id/items/:itemId/approve-design",
  authenticate,
  requireActionPermission("approve_design"),
  jobController.approveItemDesign
);

// Reject entire item design
router.post(
  "/:id/items/:itemId/reject-design",
  authenticate,
  requireActionPermission("approve_design"),
  jobController.rejectItemDesign
);

// Get design summary
router.get("/:id/design-summary", jobController.getDesignSummary);

// Legacy design upload (job-level)
router.post("/:id/upload_design", authenticate, jobController.uploadDesign);

// ═════════════════════════════════════════════════════════════════════════════
// STORE MANAGER - MATERIAL WORKFLOW & TOGGLE
// ═════════════════════════════════════════════════════════════════════════════

// Material Needed Toggle: ON / OFF (Store Manager panel)
router.patch(
  "/:id/material-needed",
  authenticate,
  requireActionPermission("store_material_allocation"),
  jobController.setMaterialNeeded
);

// Material Issue endpoints
router.post(
  "/:jobId/material/issue",
  authenticate,
  requireActionPermission("issue_material"),
  material.issueMaterial
);
router.get("/:jobId/material", material.getJobMaterials);
router.get("/:jobId/items/:itemId/material", material.getItemMaterials);

// ═════════════════════════════════════════════════════════════════════════════
// QUALITY CHECK (QC)
// ═════════════════════════════════════════════════════════════════════════════
router.post("/:id/qc/update", authenticate, requireActionPermission("qc"), jobController.updateQC);
router.post("/:id/qc/pass", authenticate, requireActionPermission("qc"), jobController.passQC);
router.post("/:id/qc/fail", authenticate, requireActionPermission("qc"), jobController.failQC);
router.post("/:id/assign-qc", authenticate, jobController.assignQC);

// ═════════════════════════════════════════════════════════════════════════════
// PRODUCTION & DESIGN FILES RETRIEVAL
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:jobId/design-files", jobController.getDesignFilesForProduction);

// ═════════════════════════════════════════════════════════════════════════════
// DELIVERY & PAYMENT WORKFLOW
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:jobId/delivery-details", jobController.getDeliveryDetails);
router.post("/:jobId/collect-payment", authenticate, requireActionPermission("delivery"), jobController.collectPaymentDelivery);
router.get("/:jobId/payment-history", jobController.getPaymentHistory);
router.post("/:id/set-delivery-mode", authenticate, requireActionPermission("delivery"), jobController.setDeliveryMode);
router.post("/:id/collect-payment", authenticate, requireActionPermission("delivery"), jobController.collectPayment);

// ═════════════════════════════════════════════════════════════════════════════
// DEDICATED FINAL JOB COMPLETION PANEL
// ═════════════════════════════════════════════════════════════════════════════
router.post("/:id/complete-delivery", authenticate, requireActionPermission("complete_job"), jobController.completeJobDelivery);

// ═════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD & ASSIGNMENTS
// ═════════════════════════════════════════════════════════════════════════════
router.post(
  "/upload",
  upload.single("image"),
  UploadImage
);

router.get("/assigned-to/:userId", jobController.getJobsAssignedToUser);

module.exports = router;