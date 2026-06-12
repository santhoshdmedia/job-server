const express  = require("express");
const router   = express.Router();
const multer   = require("multer");
const path     = require("path");

const job      = require("../controller/Job.controller");
const material = require("../controller/Material_issue.controller");

// ── Multer config for design files ───────────────────────────────────────────
const designStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, "uploads/designs/"); },
  filename:    (req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${basename}${ext}`);
  },
});
const upload = multer({
  storage: designStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|ai|psd|eps|cdr/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("File type not allowed"));
  },
});

// ── Multer config for QC images ───────────────────────────────────────────────
const qcStorage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, "uploads/qc/"); },
  filename:    (req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `qc_${Date.now()}_${basename}${ext}`);
  },
});
const qcUpload = multer({
  storage: qcStorage,
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("Only image files are allowed for QC photos"));
  },
});

// ── Middleware: run multer only for multipart requests (skip for JSON) ────────
const optionalQcUpload = (req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    return qcUpload.array("qc_images", 20)(req, res, next);
  }
  next();
};

// ── CRUD ──────────────────────────────────────────────────────────────────────
router.post("/",      job.createJob);
router.get("/",       job.getAllJobs);
router.put("/:id",    job.updateJob);
router.delete("/:id", job.deleteJob);

// NOTE: named static routes MUST come before "/:id" to avoid param collision
router.get("/assigned-to/:userId", job.getJobsAssignedToUser);

router.get("/:id", job.getJobById);

// ── Status ────────────────────────────────────────────────────────────────────
router.patch("/:id/status",  job.updateJobStatus);
router.post("/:id/approve",  job.approveJob);

// ── Sessions ──────────────────────────────────────────────────────────────────
router.post("/:id/session/open",   job.openSession);
router.post("/:id/session/close",  job.closeSession);
router.get( "/:id/session/status", job.getSessionStatus);

// ── Workflow ──────────────────────────────────────────────────────────────────
router.post("/:id/assign",         job.assignJob);
router.post("/:id/start",          job.startJob);
router.post("/:id/complete-stage", job.completeStage);
router.post("/:id/hold",           job.holdJob);
router.post("/:id/reject",         job.rejectJob);

// ── Design File (job-level / legacy) ─────────────────────────────────────────
router.post("/:id/upload_design",      upload.single("design_file"), job.uploadDesign);
router.post("/:id/approve_design",     job.approveDesign);
router.post("/:id/reject_design",      job.rejectDesign);
router.post("/:id/approve_production", job.approveProduction);
router.post("/:id/approve_qc",         job.approveqc);

// ── Quality Check ─────────────────────────────────────────────────────────────
router.post("/:id/qc/update", optionalQcUpload, job.updateQC);
router.post("/:id/qc/pass",   job.passQC);
router.post("/:id/qc/fail",   job.failQC);

// ── Material Issuance ─────────────────────────────────────────────────────────
router.post("/:jobId/material/issue", material.issueMaterial);
router.get( "/:jobId/material",       material.getJobMaterials);

// ── History & Reports ─────────────────────────────────────────────────────────
router.get("/:id/workflow",        job.getWorkflowHistory);
router.get("/:id/design-summary",  job.getDesignSummary);

// ── Conversion ────────────────────────────────────────────────────────────────
router.post("/:id/convert",  job.convertToOrder);
router.post("/:id/restore",  job.restoreJob);

// ═════════════════════════════════════════════════════════════════════════════
// PER-ITEM DESIGN ROUTES
// NOTE: these must be declared before /:id to avoid Express matching
//       "items" as an :id param — they use /:id/items/... so order is fine,
//       but keep them grouped here for clarity.
// ═════════════════════════════════════════════════════════════════════════════

// Add design files to a cart item
// POST /api/jobs/:id/items/:itemId/design-files
router.post("/:id/items/:itemId/design-files", job.addItemDesignFiles);

// Remove a single design file from a cart item
// DELETE /api/jobs/:id/items/:itemId/design-files/:fileId
router.delete("/:id/items/:itemId/design-files/:fileId", job.removeItemDesignFile);

// Approve the design for a cart item
// POST /api/jobs/:id/items/:itemId/approve-design
router.post("/:id/items/:itemId/approve-design", job.approveItemDesign);

// Reject the design for a cart item
// POST /api/jobs/:id/items/:itemId/reject-design
router.post("/:id/items/:itemId/reject-design", job.rejectItemDesign);

// Assign designers to a cart item
// POST /api/jobs/:id/items/:itemId/assign-designers
router.post("/:id/items/:itemId/assign-designers", job.assignItemDesigners);

// Remove a designer from a cart item
// DELETE /api/jobs/:id/items/:itemId/designers/:designerUserId
router.delete("/:id/items/:itemId/designers/:designerUserId", job.removeItemDesigner);

// Update a designer's status on a cart item
// PATCH /api/jobs/:id/items/:itemId/designers/:designerUserId/status
router.patch("/:id/items/:itemId/designers/:designerUserId/status", job.updateItemDesignerStatus);

module.exports = router;