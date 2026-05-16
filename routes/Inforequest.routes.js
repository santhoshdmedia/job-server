// ==================== INFO REQUEST ROUTES ====================

const express = require("express");
const router  = express.Router();
const ctrl    = require("../controller/Inforequest.controller");

// ── Designer endpoints ────────────────────────────────────────────────────────
// Submit a new request to view customer info for a job
router.post("/", ctrl.createRequest);

// Fetch the designer's own requests
router.get("/my/:userId", ctrl.myRequests);

// Fetch request status for a specific job (pass ?userId= to scope to one designer)
router.get("/job/:jobId", ctrl.getJobRequestStatus);

// ── Admin endpoints ───────────────────────────────────────────────────────────
// List all requests (filterable by ?status=pending)
router.get("/", ctrl.listRequests);

// Approve a request
router.patch("/:id/approve", ctrl.approveRequest);

// Reject a request
router.patch("/:id/reject", ctrl.rejectRequest);

module.exports = router;