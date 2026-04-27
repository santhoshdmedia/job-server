const express  = require("express");
const router   = express.Router();
const multer   = require("multer");
const path     = require("path");

const job      = require("../controller/Job.controller");
const material = require("../controller/Material_issue.controller"); // consistent lowercase

// ── Multer config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, "uploads/designs/"); },
  filename:    (req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${basename}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
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
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("Only image files are allowed for QC photos"));
  },
});

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

// ── Design File ───────────────────────────────────────────────────────────────
router.post("/:id/upload_design",  upload.single("design_file"), job.uploadDesign);
router.post("/:id/approve_design", job.approveDesign);
router.post("/:id/reject_design",  job.rejectDesign);

// ── Quality Check (NEW) ───────────────────────────────────────────────────────
router.post("/:id/qc/update",          qcUpload.array("qc_images", 20), job.updateQC);
router.post("/:id/qc/pass",            job.passQC);
router.post("/:id/qc/fail",            job.failQC);

// ── Material Issuance ─────────────────────────────────────────────────────────
router.post("/:jobId/material/issue",  material.issueMaterial);
router.get( "/:jobId/material",        material.getJobMaterials);

// ── History & Reports ─────────────────────────────────────────────────────────
router.get("/:id/workflow", job.getWorkflowHistory);

// ── Conversion ────────────────────────────────────────────────────────────────
router.post("/:id/convert", job.convertToOrder);

module.exports = router;