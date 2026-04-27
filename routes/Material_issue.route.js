// ==================== MATERIAL ISSUE ROUTES ====================
// File: routes/material_issue.routes.js
//
// Mount in app.js:
//   const materialRoutes = require("./routes/material_issue.routes");
//   app.use("/api/material", materialRoutes);
//
//   Also add this line to your existing job routes file:
//   const materialRoutes = require("./material_issue.routes");
//   router.use("/:jobId/material", (req, res, next) => {
//     req.params.jobId = req.params.jobId; next();
//   }, materialRoutes);   ← see job-scoped routes below

const express = require("express");
const router  = express.Router();

const {
  calculateMaterial,
  issueMaterial,
  recordReturn,
  managerReview,
  updateManagerReview,
  getJobMaterials,
  getMaterialIssue,
  getEmployeeMaterials,
  getAllMaterialIssues,
  wastageReport,
  getFlaggedIssues,
  deleteMaterialIssue,
} = require("../controller/Material_issue.controller");


// POST /api/material/calculate
router.post("/calculate", calculateMaterial);

// ─────────────────────────────────────────────────────────────────────────────
// REPORTING  (must come BEFORE /:issueId to avoid route conflicts)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/report/wastage", wastageReport);

// GET /api/material/flagged?page=1&limit=20
router.get("/flagged", getFlaggedIssues);

// GET /api/material/employee/:userId?status=returned&page=1&limit=20
router.get("/employee/:userId", getEmployeeMaterials);

// ─────────────────────────────────────────────────────────────────────────────
// LIST ALL ISSUES  (admin view with filters)
// GET /api/material?status=issued&employee_id=...&product_id=...
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", getAllMaterialIssues);

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE ISSUE CRUD
// ─────────────────────────────────────────────────────────────────────────────

// Get a single issue (full detail with calculation + return + review)
// GET /api/material/:issueId
router.get("/:issueId", getMaterialIssue);

// Record return for an issue
// POST /api/material/:issueId/return
router.post("/:issueId/return", recordReturn);

// Manager review (first-time)
// POST /api/material/:issueId/review
router.post("/:issueId/review", managerReview);

// Manager review update (correct an existing review)
// PUT /api/material/:issueId/review
router.put("/:issueId/review", updateManagerReview);

// Soft delete (only status=issued, no return yet)
// DELETE /api/material/:issueId
router.delete("/:issueId", deleteMaterialIssue);

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
// JOB-SCOPED ROUTES
// Add these lines inside your existing job.routes.js:
//
//   const materialCtrl = require("../controller/material_issue.controller");
//
//   // Issue material for a specific job
//   // POST /api/jobs/:jobId/material/issue
//   router.post("/:jobId/material/issue", materialCtrl.issueMaterial);
//
//   // Get all material issues for a specific job
//   // GET /api/jobs/:jobId/material
//   router.get("/:jobId/material", materialCtrl.getJobMaterials);
//
// ─────────────────────────────────────────────────────────────────────────────


/*
=============================================================================
FULL API REFERENCE
=============================================================================

── UTILITY ──────────────────────────────────────────────────────────────────

POST   /api/material/calculate
  → Preview how much material a job needs before issuing.
  Body: { width_ft, height_ft, margin_top_in?, margin_bottom_in?, wastage_buffer_pct? }

── JOB-SCOPED ───────────────────────────────────────────────────────────────

POST   /api/jobs/:jobId/material/issue
  → Store manager issues material to an employee for a specific job.
  Body: { cart_item_index?, material{product_id,unit}, issued_qty, dimensions{width,height},
          margin_top_in?, margin_bottom_in?, wastage_buffer_pct?,
          issued_to{user_id,name,role}, issued_by{user_id,name,role}, issue_notes? }

GET    /api/jobs/:jobId/material
  → All material issues for a job with aggregate totals.

── ISSUE LIFECYCLE ──────────────────────────────────────────────────────────

GET    /api/material/:issueId
  → Full issue detail (dimensions, calculation, issuance, return, review).

POST   /api/material/:issueId/return
  → Employee returns leftover material. Triggers wastage calculation + auto-rating.
  Body: { returned_qty, wastage_reason, wastage_reason_notes?, returned_by{user_id,name,role} }

POST   /api/material/:issueId/review
  → Manager records performance review after return.
  Body: { manager_by{user_id,name}, manager_notes?, override_rating? }

PUT    /api/material/:issueId/review
  → Manager updates/corrects existing review.
  Body: { manager_by{user_id,name}, manager_notes?, override_rating? }

DELETE /api/material/:issueId
  → Soft-delete an unprocessed issue (status=issued). Restores stock.

── LISTS & REPORTS ──────────────────────────────────────────────────────────

GET    /api/material
  → All issues. Filters: status, employee_id, product_id, job_no,
    is_flagged, manager_reviewed, page, limit, sort_by, sort_order

GET    /api/material/employee/:userId
  → All issues for one employee with aggregate performance stats.
  Filters: status, page, limit

GET    /api/material/flagged
  → High-wastage issues pending manager review.

GET    /api/material/report/wastage
  → Full wastage analytics: overall totals, per-employee, per-material, per-reason.
  Filters: from (YYYY-MM-DD), to, employee_id, product_id

=============================================================================
COMPLETE USAGE EXAMPLE — 3-day flex roll job
=============================================================================

// Step 1: Preview required material
POST /api/material/calculate
{
  "width_ft": 4, "height_ft": 6,
  "margin_top_in": 4, "margin_bottom_in": 3,
  "wastage_buffer_pct": 20
}
// → required_sqft: 31.6

// Step 2: Manager issues material to employee Ravi
POST /api/jobs/JOB_ID/material/issue
{
  "material": { "product_id": "FLEX_ROLL_ID", "unit": "sqft" },
  "issued_qty": 31.6,
  "dimensions": { "width": 4, "height": 6, "unit": "ft" },
  "issued_to": { "user_id": "RAVI_ID", "name": "Ravi", "role": "printing team" },
  "issued_by": { "user_id": "MGR_ID",  "name": "Store Manager", "role": "store manager" }
}
// → issue_no: MI0001, stock decremented by 31.6

// Step 3: Ravi finishes printing, returns leftover material
POST /api/material/MI_OBJECT_ID/return
{
  "returned_qty": 4.8,
  "wastage_reason": "margin_trim",
  "wastage_reason_notes": "Standard 4+3 inch trim",
  "returned_by": { "user_id": "RAVI_ID", "name": "Ravi", "role": "printing team" }
}
// Calculations:
//   actual_used      = 31.6 - 4.8  = 26.8 sqft
//   actual_wastage   = 26.8 - 24   = 2.8 sqft  (job area = 4×6 = 24)
//   expected_wastage = gross(26.33) - 24 = 2.33 sqft
//   wastage_ratio    = (2.8 / 31.6) × 100 = 8.86%
//   performance      = "good"  (≤10%)
// → stock incremented by 4.8 (returned)

// Step 4: Manager reviews performance
POST /api/material/MI_OBJECT_ID/review
{
  "manager_by": { "user_id": "MGR_ID", "name": "Store Manager" },
  "manager_notes": "Excellent work, minimal wastage."
}

// Step 5: Check employee performance history
GET /api/material/employee/RAVI_ID
// → avg_wastage_pct, overall_rating, performance_counts

// Step 6: Monthly wastage report
GET /api/material/report/wastage?from=2024-01-01&to=2024-01-31
// → overall, by_employee (ranked worst-first), by_material, by_wastage_reason

=============================================================================
*/