// ==================== MATERIAL ISSUE ROUTES ====================
// File: routes/material_issue.routes.js
//
// Mount in app.js:
//   const materialRoutes = require("./routes/material_issue.routes");
//   app.use("/api/material", materialRoutes);

const express = require("express");
const router  = express.Router();

const {
  calculateMaterial,
  issueMaterial,
  issueForDesignFile,
  recordProductionCompletion,
  reassignIssuedTo,
  recordReturn,
  managerReview,
  updateManagerReview,
  getJobMaterials,
  getItemMaterials,
  getIssuesByDesignFile,
  getMaterialIssue,
  getEmployeeMaterials,
  getAllMaterialIssues,
  wastageReport,
  getFlaggedIssues,
  deleteMaterialIssue,
  assignPickup,
  updatePickupStatus,
  getPickupsByUser,
  listIssues,
  getOutsourceIssues,
} = require("../controller/Material_issue.controller");

// ── UTILITY ──────────────────────────────────────────────────────────────────
// POST /api/material/calculate
router.post("/calculate", calculateMaterial);

// ── REPORTING  (must come BEFORE /:issueId to avoid route conflicts) ──────────
// GET /api/material/report/wastage
router.get("/report/wastage", wastageReport);

// GET /api/material/flagged
router.get("/flagged", getFlaggedIssues);

// GET /api/material/employee/:userId
router.get("/employee/:userId", getEmployeeMaterials);

// GET /api/material/by-file/:fileId
router.get("/by-file/:fileId", getIssuesByDesignFile);

// ── LIST ──────────────────────────────────────────────────────────────────────
// GET /api/material
router.get("/", getAllMaterialIssues);

// GET /api/material/list
router.get("/list", listIssues);

// ── OUTSOURCE ISSUES ──────────────────────────────────────────────────────────
// GET /api/material/outsource
router.get("/outsource", getOutsourceIssues);

// ── PICKUP ASSIGNMENT ─────────────────────────────────────────────────────────

// POST /api/material/:issueId/assign-pickup
// Assign a person, destination, and time to collect an outsource issue
router.post("/:issueId/assign-pickup", assignPickup);

// PATCH /api/material/:issueId/pickup/status
// BUG FIX: was PUT /pickup/:pickupId/status — wrong method, wrong param name.
// Controller reads req.params.issueId, so the param must be :issueId.
// PATCH is more semantically correct for a partial status update.
router.patch("/:issueId/pickup/status", updatePickupStatus);

// GET /api/material/pickups/user/:userId
// BUG FIX: was GET /pickups/:userId — missing the /user/ segment that matches
// the controller's documented path and avoids collision with /:issueId routes.
router.get("/pickups/user/:userId", getPickupsByUser);

// ── SINGLE ISSUE CRUD ─────────────────────────────────────────────────────────

// GET /api/material/:issueId
router.get("/:issueId", getMaterialIssue);

// POST /api/material/:issueId/production
router.post("/:issueId/production", recordProductionCompletion);

// POST /api/material/:issueId/reassign
// Hand an in-house production task off to a different staff member.
router.post("/:issueId/reassign", reassignIssuedTo);

// POST /api/material/:issueId/return
router.post("/:issueId/return", recordReturn);

// POST /api/material/:issueId/review
router.post("/:issueId/review", managerReview);

// PUT /api/material/:issueId/review
router.put("/:issueId/review", updateManagerReview);

// DELETE /api/material/:issueId
router.delete("/:issueId", deleteMaterialIssue);

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
// JOB-SCOPED ROUTES  (add to your existing job.routes.js)
// ─────────────────────────────────────────────────────────────────────────────
//
//   const materialCtrl = require("../controller/Material_issue.controller");
//
//   // POST /api/jobs/:jobId/material/issue
//   router.post("/:jobId/material/issue", materialCtrl.issueMaterial);
//
//   // GET /api/jobs/:jobId/material
//   router.get("/:jobId/material", materialCtrl.getJobMaterials);
//
//   // GET /api/jobs/:jobId/items/:itemId/material
//   router.get("/:jobId/items/:itemId/material", materialCtrl.getItemMaterials);
//
//   // POST /api/jobs/:jobId/items/:itemId/design-files/:fileId/material/issue
//   router.post("/:jobId/items/:itemId/design-files/:fileId/material/issue",
//               materialCtrl.issueForDesignFile);