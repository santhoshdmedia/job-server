// ==================== INFO REQUEST CONTROLLER ====================
//
// Handles designer requests to view customer PII (name / phone) for a job.
// Admins review and approve / reject via a separate endpoint.
//
// Routes (see inforequest.routes.js):
//   POST   /api/info-requests                   — designer creates request
//   GET    /api/info-requests                   — admin lists all (filterable)
//   GET    /api/info-requests/my/:userId        — designer sees their own requests
//   GET    /api/info-requests/job/:jobId        — get request status for a job (by userId query param)
//   PATCH  /api/info-requests/:id/approve       — admin approves
//   PATCH  /api/info-requests/:id/reject        — admin rejects

const mongoose    = require("mongoose");
const InfoRequest = require("../modals/Inforequest.modal");
const Job         = require("../modals/job.modal");

// ─── helpers ─────────────────────────────────────────────────────────────────
const resp = (res, status, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null) payload.data = data;
  return res.status(status).json(payload);
};

// How long approved access is valid (ms). Default: 24 hours.
const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE REQUEST
// POST /api/info-requests
// Body: { job_id, requested_by: { user_id, name, role }, request_reason? }
// ─────────────────────────────────────────────────────────────────────────────
exports.createRequest = async (req, res) => {
  try {
    const { job_id, requested_by, request_reason = "" } = req.body;

    if (!job_id)
      return resp(res, 400, false, "job_id is required.");
    if (!requested_by?.user_id || !requested_by?.name)
      return resp(res, 400, false, "requested_by.user_id and name are required.");
    if (!mongoose.Types.ObjectId.isValid(job_id))
      return resp(res, 400, false, "Invalid job_id.");

    const job = await Job.findById(job_id).select("job_no customer_name").lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    // Check for an already-active (pending or approved-and-unexpired) request
    const existing = await InfoRequest.findOne({
      job_id,
      "requested_by.user_id": requested_by.user_id,
      status: { $in: ["pending", "approved"] },
    }).lean();

    if (existing) {
      if (existing.status === "pending") {
        return resp(res, 409, false, "You already have a pending request for this job.", existing);
      }
      // approved — check expiry
      if (existing.status === "approved") {
        const now = new Date();
        if (!existing.expires_at || existing.expires_at > now) {
          return resp(res, 409, false, "You already have active approved access for this job.", existing);
        }
        // expired — fall through to create a new one
      }
    }

    const newReq = await InfoRequest.create({
      job_id,
      job_no: job.job_no,
      requested_by: {
        user_id: requested_by.user_id,
        name:    requested_by.name,
        role:    requested_by.role || "",
      },
      request_reason,
      status: "pending",
    });

    return resp(res, 201, true, "Info request submitted. Waiting for admin approval.", newReq);
  } catch (err) {
    console.error("createRequest:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIST ALL REQUESTS (admin)
// GET /api/info-requests?status=pending&page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────
exports.listRequests = async (req, res) => {
  try {
    const {
      status,
      page  = 1,
      limit = 20,
      sort_order = "desc",
    } = req.query;

    const filter = {};
    if (status) filter.status = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await InfoRequest.countDocuments(filter);
    const docs  = await InfoRequest.find(filter)
      .sort({ createdAt: sort_order === "asc" ? 1 : -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    return resp(res, 200, true, "Requests fetched.", {
      requests: docs,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("listRequests:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. MY REQUESTS (designer)
// GET /api/info-requests/my/:userId
// ─────────────────────────────────────────────────────────────────────────────
exports.myRequests = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId))
      return resp(res, 400, false, "Invalid userId.");

    const docs = await InfoRequest.find({ "requested_by.user_id": userId })
      .sort({ createdAt: -1 })
      .lean();

    return resp(res, 200, true, "Your requests fetched.", docs);
  } catch (err) {
    console.error("myRequests:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. GET REQUEST STATUS FOR A SPECIFIC JOB (by requester)
// GET /api/info-requests/job/:jobId?userId=<userId>
// ─────────────────────────────────────────────────────────────────────────────
exports.getJobRequestStatus = async (req, res) => {
  try {
    const { jobId }  = req.params;
    const { userId } = req.query;

    if (!mongoose.Types.ObjectId.isValid(jobId))
      return resp(res, 400, false, "Invalid jobId.");

    const filter = { job_id: jobId };
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      filter["requested_by.user_id"] = userId;
    }

    // Return the most-recent request
    const doc = await InfoRequest.findOne(filter)
      .sort({ createdAt: -1 })
      .lean();

    if (!doc) {
      return resp(res, 200, true, "No request found.", {
        status:       "none",
        has_access:   false,
        request:      null,
      });
    }

    const now        = new Date();
    const isExpired  = doc.expires_at && doc.expires_at < now;
    const has_access = doc.status === "approved" && !isExpired;

    return resp(res, 200, true, "Request status fetched.", {
      status:     doc.status,
      has_access,
      is_expired: isExpired,
      request:    doc,
    });
  } catch (err) {
    console.error("getJobRequestStatus:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. APPROVE REQUEST (admin)
// PATCH /api/info-requests/:id/approve
// Body: { reviewed_by: { user_id, name }, review_notes?, ttl_hours? }
// ─────────────────────────────────────────────────────────────────────────────
exports.approveRequest = async (req, res) => {
  try {
    const { reviewed_by, review_notes = "", ttl_hours } = req.body;

    if (!reviewed_by?.user_id || !reviewed_by?.name)
      return resp(res, 400, false, "reviewed_by.user_id and name are required.");

    const doc = await InfoRequest.findById(req.params.id);
    if (!doc) return resp(res, 404, false, "Request not found.");
    if (doc.status !== "pending")
      return resp(res, 409, false, `Request is already "${doc.status}".`);

    const ttlMs = ttl_hours
      ? parseInt(ttl_hours, 10) * 60 * 60 * 1000
      : ACCESS_TTL_MS;

    doc.status       = "approved";
    doc.reviewed_by  = { user_id: reviewed_by.user_id, name: reviewed_by.name };
    doc.reviewed_at  = new Date();
    doc.review_notes = review_notes;
    doc.expires_at   = new Date(Date.now() + ttlMs);

    await doc.save();

    return resp(res, 200, true, "Request approved. Designer now has access.", doc);
  } catch (err) {
    console.error("approveRequest:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. REJECT REQUEST (admin)
// PATCH /api/info-requests/:id/reject
// Body: { reviewed_by: { user_id, name }, review_notes }
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectRequest = async (req, res) => {
  try {
    const { reviewed_by, review_notes = "" } = req.body;

    if (!reviewed_by?.user_id || !reviewed_by?.name)
      return resp(res, 400, false, "reviewed_by.user_id and name are required.");

    const doc = await InfoRequest.findById(req.params.id);
    if (!doc) return resp(res, 404, false, "Request not found.");
    if (doc.status !== "pending")
      return resp(res, 409, false, `Request is already "${doc.status}".`);

    doc.status       = "rejected";
    doc.reviewed_by  = { user_id: reviewed_by.user_id, name: reviewed_by.name };
    doc.reviewed_at  = new Date();
    doc.review_notes = review_notes;

    await doc.save();

    return resp(res, 200, true, "Request rejected.", doc);
  } catch (err) {
    console.error("rejectRequest:", err);
    return resp(res, 500, false, err.message);
  }
};