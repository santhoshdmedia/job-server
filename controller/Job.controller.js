// ==================== JOB CONTROLLER ====================

const mongoose = require("mongoose");
const Job = require("../modals/job.modal");
const AdminUsers = require("../modals/adminusers.modals");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const VALID_STATUSES = [
  "draft", "accepted", "in_progress", "on_hold", "quality_check",
  "passed", "failed", "completed", "rejected", "converted", "expired",
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const generateJobNo = async () => {
  const prefix = "DM";
  const last = await Job.findOne({ job_no: new RegExp(`^${prefix}\\d+$`) })
    .sort({ job_no: -1 })
    .select("job_no")
    .lean();
  let seq = 1;
  if (last) {
    const parsed = parseInt(last.job_no.replace(prefix, ""), 10);
    if (!isNaN(parsed)) seq = parsed + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
};

const resp = (res, status, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null) payload.data = data;
  return res.status(status).json(payload);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE JOB
// POST /api/jobs
// ─────────────────────────────────────────────────────────────────────────────
exports.createJob = async (req, res) => {
  try {
    const job_no = await generateJobNo();
    const jobData = await Job.create({ ...req.body, job_no });
    return resp(res, 201, true, "Job created successfully.", jobData);
  } catch (err) {
    console.error("createJob:", err);
    if (err.code === 11000 && err.keyPattern?.job_no)
      return resp(res, 409, false, "Job number conflict, please retry.");
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET ALL JOBS
// GET /api/jobs?status=in_progress&stage=design&page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllJobs = async (req, res) => {
  try {
    const {
      status, stage, customer_name, job_no,
      page = 1, limit = 20, sort_by = "createdAt", sort_order = "desc",
    } = req.query;

    const filter = {};
    if (status)        filter.job_status             = status;
    if (stage)         filter["current_stage.stage"] = stage;
    if (customer_name) filter.customer_name          = new RegExp(customer_name, "i");
    if (job_no)        filter.job_no                 = new RegExp(job_no, "i");

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const sort  = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total = await Job.countDocuments(filter);

    const jobs = await Job.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .select("-workflow_stages")
      .lean();

    return resp(res, 200, true, "Jobs fetched successfully.", {
      jobs,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getAllJobs:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET SINGLE JOB
// GET /api/jobs/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getJobById = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate("workflow_stages.handled_by.user_id",    "name role email")
      .populate("workflow_stages.assigned_by.user_id",   "name role")
      .populate("workflow_stages.work_sessions.user_id", "name role email")
      .populate("current_stage.assigned_to.user_id",     "name role email")
      .lean();
    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, "Job fetched successfully.", job);
  } catch (err) {
    console.error("getJobById:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. UPDATE JOB
// PUT /api/jobs/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateJob = async (req, res) => {
  try {
    const allowedFields = [
      "customer_name", "customer_phone", "cart_items", "delivery_address",
      "estimated_delivery_date", "order_date", "subtotal", "discount_percentage",
      "discount_amount", "taxable_amount", "tax_amount", "delivery_charges",
      "free_delivery", "total_amount", "gst_no", "valid_until",
      "notes", "terms_and_conditions", "payment_amount", "payment_mode",
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (!Object.keys(updates).length)
      return resp(res, 400, false, "No valid fields provided to update.");

    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, "Job updated successfully.", job);
  } catch (err) {
    console.error("updateJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. UPDATE JOB STATUS
// PATCH /api/jobs/:id/status
// ─────────────────────────────────────────────────────────────────────────────
exports.updateJobStatus = async (req, res) => {
  try {
    const { job_status } = req.body;
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: { job_status, status_updated_at: new Date() } },
      { new: true }
    ).lean();
    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, `Job status updated to "${job_status}".`, job);
  } catch (err) {
    console.error("updateJobStatus:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. APPROVE JOB
// POST /api/jobs/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
exports.approveJob = async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_by, approved_by_admin_id, assign_to, job_status } = req.body;

    if (!approved_by || !approved_by_admin_id)
      return resp(res, 400, false, "Approver name and ID are required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    if (!assign_to?.user_id)
      return resp(res, 400, false, "A designer must be assigned when approving.");

    const designer = await AdminUsers.findById(assign_to.user_id);
    if (!designer || designer.role !== "designing team")
      return resp(res, 400, false, "Selected user is not a valid designer.");

    const now = new Date();

    job.job_status           = job_status || "accepted";
    job.approved_by          = approved_by;
    job.approved_by_admin_id = approved_by_admin_id;
    job.status_updated_at    = now;

    job.workflow_stages.push({
      stage:       "design",
      stage_label: "Design",
      handled_by:  { user_id: designer._id, name: designer.name, role: designer.role },
      assigned_by: { user_id: approved_by_admin_id, name: approved_by },
      action:      "assigned",
      assigned_at: now,
      work_sessions: [],
      notes: "Job approved and assigned by admin",
    });

    job.current_stage = {
      stage:        "design",
      stage_label:  "Design",
      stage_action: "assigned",
      assigned_to:  { user_id: designer._id, name: designer.name, role: designer.role },
      since:        now,
    };

    await job.save();
    return resp(res, 200, true, `Job approved and assigned to ${designer.name}.`, job);
  } catch (err) {
    console.error("approveJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. ASSIGN JOB
// POST /api/jobs/:id/assign
// ─────────────────────────────────────────────────────────────────────────────
exports.assignJob = async (req, res) => {
  try {
    const { stage, stage_label, assigned_to, assigned_by, notes } = req.body;

    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!assigned_to?.user_id || !assigned_to?.name)
      return resp(res, 400, false, "assigned_to.user_id and assigned_to.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();

    job.workflow_stages.push({
      stage,
      stage_label:   stage_label || "",
      handled_by:    { user_id: assigned_to.user_id, name: assigned_to.name, role: assigned_to.role || "" },
      assigned_by:   assigned_by || {},
      action:        "assigned",
      assigned_at:   now,
      work_sessions: [],
      notes:         notes || "",
    });

    job.current_stage = {
      stage,
      stage_label:  stage_label || "",
      stage_action: "assigned",
      assigned_to:  { user_id: assigned_to.user_id, name: assigned_to.name, role: assigned_to.role || "" },
      since:        now,
    };
    job.status_updated_at = now;
    await job.save();

    return resp(res, 200, true, `Job assigned to ${assigned_to.name} at stage "${stage}".`, job);
  } catch (err) {
    console.error("assignJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. OPEN SESSION
// POST /api/jobs/:id/session/open
// ─────────────────────────────────────────────────────────────────────────────
exports.openSession = async (req, res) => {
  try {
    const { stage, stage_label, user, notes } = req.body;

    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!user?.user_id || !user?.name)
      return resp(res, 400, false, "user.user_id and user.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    if (job.hasOpenSession(stage)) {
      return resp(res, 409, false,
        `A session for stage "${stage}" is already open on job ${job.job_no}. Close it first.`
      );
    }

    job.openSession({ stageName: stage, stageLabel: stage_label, user, notes });
    await job.save();

    const summary = job.getSessionSummary(stage);
    return resp(res, 200, true, `Session opened for stage "${stage}" on job ${job.job_no}.`, {
      job_no:        job.job_no,
      job_status:    job.job_status,  
      stage_summary: summary,
    });
  } catch (err) {
    console.error("openSession:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLOSE SESSION
// POST /api/jobs/:id/session/close
// ─────────────────────────────────────────────────────────────────────────────
exports.closeSession = async (req, res) => {
  try {
    const { stage, action, notes } = req.body;

    if (!stage)  return resp(res, 400, false, "stage is required.");
    if (!action) return resp(res, 400, false, "action is required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.closeSession({ stageName: stage, action, notes });
    await job.save();

    const summary = job.getSessionSummary(stage);
    const msgs = {
      on_hold:   `Session paused. Worked ${summary.total_duration_display} across ${summary.worked_days} day(s) so far.`,
      completed: `Stage completed! Total time: ${summary.total_duration_display} across ${summary.worked_days} day(s).`,
      rejected:  `Stage rejected. Total time logged: ${summary.total_duration_display}.`,
      passed:    `Stage passed. Total time logged: ${summary.total_duration_display}.`,
    };

    return resp(res, 200, true, msgs[action] || `Session closed with action "${action}".`, {
      job_no:        job.job_no,
      job_status:    job.job_status,
      stage_summary: summary,
    });
  } catch (err) {
    console.error("closeSession:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET SESSION STATUS
// GET /api/jobs/:id/session/status?stage=quality_check
// ─────────────────────────────────────────────────────────────────────────────
exports.getSessionStatus = async (req, res) => {
  try {
    const { stage } = req.query;

    const job = await Job.findById(req.params.id)
      .select("job_no job_status current_stage workflow_stages")
      .lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    const workflowStages = Array.isArray(job.workflow_stages) ? job.workflow_stages : [];

    if (stage) {
      const stageEntry = workflowStages.find((s) => s.stage === stage);

      if (!stageEntry) {
        return resp(res, 200, true, "Session status fetched.", {
          job_no:                 job.job_no,
          job_status:             job.job_status,
          stage,
          stage_action:           "assigned",
          has_open_session:       false,
          open_since:             null,
          total_sessions:         0,
          closed_sessions:        0,
          total_duration_seconds: 0,
          total_duration_display: "00:00:00",
          worked_days:            0,
          daily_summary:          [],
          work_sessions:          [],
        });
      }

      const sessions    = Array.isArray(stageEntry.work_sessions) ? stageEntry.work_sessions : [];
      const openSession = sessions.find((s) => !s.session_end);

      return resp(res, 200, true, "Session status fetched.", {
        job_no:                 job.job_no,
        job_status:             job.job_status,
        stage,
        stage_action:           stageEntry.action,
        has_open_session:       !!openSession,
        open_since:             openSession?.session_start || null,
        total_sessions:         sessions.length,
        closed_sessions:        sessions.filter((s) => s.session_end).length,
        total_duration_seconds: stageEntry.total_duration_seconds || 0,
        total_duration_display: stageEntry.total_duration_display || "00:00:00",
        worked_days:            stageEntry.worked_days || 0,
        daily_summary:          stageEntry.daily_summary || [],
        work_sessions:          sessions,
      });
    }

    // No stage filter — return all stages summary
    const stageSummaries = workflowStages.map((s) => {
      const sessions = Array.isArray(s.work_sessions) ? s.work_sessions : [];
      return {
        stage:                  s.stage,
        stage_label:            s.stage_label,
        action:                 s.action,
        total_sessions:         sessions.length,
        closed_sessions:        sessions.filter((x) => x.session_end).length,
        has_open_session:       sessions.some((x) => !x.session_end),
        total_duration_seconds: s.total_duration_seconds || 0,
        total_duration_display: s.total_duration_display || "00:00:00",
        worked_days:            s.worked_days || 0,
        daily_summary:          s.daily_summary || [],
      };
    });

    return resp(res, 200, true, "All stage session statuses fetched.", {
      job_no:        job.job_no,
      job_status:    job.job_status,
      current_stage: job.current_stage,
      stages:        stageSummaries,
    });
  } catch (err) {
    console.error("getSessionStatus:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. START JOB (legacy)
// POST /api/jobs/:id/start
// ─────────────────────────────────────────────────────────────────────────────
exports.startJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;

    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!handled_by?.user_id || !handled_by?.name)
      return resp(res, 400, false, "handled_by.user_id and handled_by.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.openSession({
      stageName: stage,
      user: { user_id: handled_by.user_id, name: handled_by.name, role: handled_by.role || "" },
      notes,
    });
    await job.save();

    return resp(res, 200, true, "Job marked as started.", job);
  } catch (err) {
    console.error("startJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. COMPLETE STAGE & HANDOFF
// POST /api/jobs/:id/complete-stage
// ─────────────────────────────────────────────────────────────────────────────
exports.completeStage = async (req, res) => {
  try {
    const { stage, handled_by, notes, next_stage, next_assigned_to } = req.body;

    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!handled_by?.user_id || !handled_by?.name)
      return resp(res, 400, false, "handled_by is required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now        = new Date();
    const stageEntry = job.getActiveStage(stage);
    if (stageEntry) job.closeSession({ stageName: stage, action: "completed", notes });

    if (next_stage) {
      const assignedTo = next_assigned_to || handled_by;
      job.workflow_stages.push({
        stage:         next_stage,
        stage_label:   "",
        handled_by:    { user_id: assignedTo.user_id, name: assignedTo.name, role: assignedTo.role || "" },
        assigned_by:   { user_id: handled_by.user_id, name: handled_by.name },
        action:        "assigned",
        assigned_at:   now,
        work_sessions: [],
        notes:         `Handed off from ${stage} → ${next_stage}`,
      });

      job.current_stage = {
        stage:                  next_stage,
        stage_label:            "",
        stage_action:           "assigned",
        assigned_to:            { user_id: assignedTo.user_id, name: assignedTo.name, role: assignedTo.role || "" },
        since:                  now,
        total_duration_seconds: 0,
        total_duration_display: "00:00:00",
        worked_days:            0,
      };
    } else {
      job.job_status = "completed";
    }

    job.status_updated_at = now;
    await job.save();

    const message = next_stage
      ? `Stage "${stage}" completed. Handed off to "${next_stage}".`
      : `Stage "${stage}" completed. Job marked as completed.`;

    return resp(res, 200, true, message, job);
  } catch (err) {
    console.error("completeStage:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 13. PUT JOB ON HOLD
// POST /api/jobs/:id/hold
// ─────────────────────────────────────────────────────────────────────────────
exports.holdJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;
    if (!stage || !handled_by?.user_id)
      return resp(res, 400, false, "stage and handled_by are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    if (job.hasOpenSession(stage)) {
      job.closeSession({ stageName: stage, action: "on_hold", notes });
    } else {
      const stageEntry = job.getActiveStage(stage);
      if (stageEntry) stageEntry.action = "on_hold";
      job.job_status        = "on_hold";
      job.status_updated_at = new Date();
    }

    await job.save();
    return resp(res, 200, true, "Job placed on hold.", job);
  } catch (err) {
    console.error("holdJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. REJECT JOB AT STAGE
// POST /api/jobs/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;
    if (!stage || !handled_by?.user_id)
      return resp(res, 400, false, "stage and handled_by are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    if (job.hasOpenSession(stage)) {
      job.closeSession({ stageName: stage, action: "rejected", notes });
    } else {
      const stageEntry = job.getActiveStage(stage);
      if (stageEntry) {
        stageEntry.action       = "rejected";
        stageEntry.completed_at = new Date();
      }
      job.job_status        = "rejected";
      job.status_updated_at = new Date();
    }

    await job.save();
    return resp(res, 200, true, "Job rejected.", job);
  } catch (err) {
    console.error("rejectJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. UPLOAD DESIGN FILE
// POST /api/jobs/:id/upload_design
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadDesign = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const {
      notes             = "",
      duration_seconds  = 0,
      duration_display  = "00:00:00",
      design_file       = "",
      design_drive_link = "",
      stage             = job.current_stage?.stage || "design",
      handled_by        = {},
      is_sample         = false,
    } = req.body;

    let handledByObj = {};
    if (typeof handled_by === "string") {
      try { handledByObj = JSON.parse(handled_by); } catch { handledByObj = {}; }
    } else {
      handledByObj = handled_by;
    }

    if (!design_file && !design_drive_link)
      return resp(res, 400, false, "At least a design file path or Drive link is required.");

    job.design_file             = design_file || job.design_file;
    job.design_drive_link       = design_drive_link || job.design_drive_link;
    job.design_uploaded_at      = new Date();
    job.design_uploaded_by      = handledByObj.name || "";
    job.design_duration_seconds = parseInt(duration_seconds, 10) || 0;
    job.design_duration_display = duration_display;
    job.design_status           = "uploaded";
    job.design_is_sample        = is_sample === true || is_sample === "true";

    if (job.hasOpenSession(stage))
      job.closeSession({ stageName: stage, action: "completed", notes });

    await job.save();

    return resp(res, 200, true, "Design uploaded successfully.", {
      design_file:             job.design_file,
      design_drive_link:       job.design_drive_link,
      design_status:           job.design_status,
      design_duration_display: job.design_duration_display,
    });
  } catch (err) {
    console.error("uploadDesign:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 16. APPROVE DESIGN
// POST /api/jobs/:id/approve_design
// ─────────────────────────────────────────────────────────────────────────────
exports.approveDesign = async (req, res) => {
  try {
    const { handled_by, design_file,drive_link } = req.body;

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.design_status      = "approved";
    job.design_approved_at = new Date();
    job.design_approved_by = handled_by?.user_id || "Admin";
    if (design_file) job.design_file = design_file;
    if (drive_link) job.design_drive_link = drive_link;
    await job.save();

    return resp(res, 200, true, "Design approved.", { design_status: job.design_status });
  } catch (err) {
    console.error("approveDesign:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 16b. APPROVE PRODUCTION
// POST /api/jobs/:id/approve_production
// ─────────────────────────────────────────────────────────────────────────────
exports.approveProduction = async (req, res) => {
  try {
    const { handled_by, productionimg } = req.body;

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.production_status      = "production_completed";
    job.production_approved_at = new Date();
    job.production_approved_by = handled_by?.user_id || "Admin";
    if (productionimg) job.productionimg = productionimg;
    await job.save();

    return resp(res, 200, true, "Production approved.", { production_status: job.production_status });
  } catch (err) {
    console.error("approveProduction:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 16c. APPROVE QC (legacy single-image)
// POST /api/jobs/:id/approve_qc
// ─────────────────────────────────────────────────────────────────────────────
exports.approveqc = async (req, res) => {
  try {
    const { handled_by, qcimg } = req.body;

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.qc_status      = "qc_completed";
    job.qc_approved_at = new Date();
    job.qc_approved_by = handled_by?.user_id || "Admin";
    if (qcimg) job.qcimg = qcimg;
    await job.save();

    return resp(res, 200, true, "QC approved.", { qc_status: job.qc_status });
  } catch (err) {
    console.error("approveQC:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 17. REJECT DESIGN
// POST /api/jobs/:id/reject_design
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectDesign = async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.trim())
      return resp(res, 400, false, "Rejection reason is required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.design_status           = "rejected";
    job.design_rejection_reason = notes;
    await job.save();

    return resp(res, 200, true, "Design rejected with feedback.", {
      design_status:           job.design_status,
      design_rejection_reason: job.design_rejection_reason,
    });
  } catch (err) {
    console.error("rejectDesign:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 18. UPDATE QC — save photos (S3 URLs or local files) + notes
// POST /api/jobs/:id/qc/update
//
// Accepts EITHER:
//   • JSON body:      { qc_images: ["https://s3.aws.../photo.jpg", ...], qc_notes, duration_seconds, duration_display, handled_by }
//   • multipart:      qc_images[] files + qc_notes etc. (legacy multer upload)
//
// NEW images are APPENDED to existing ones (not replaced).
// ─────────────────────────────────────────────────────────────────────────────
exports.updateQC = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const {
      qc_notes         = "",
      duration_seconds = 0,
      duration_display = "00:00:00",
      qc_images        = [],   // array of S3 URL strings sent from React frontend
      handled_by       = {},
    } = req.body;

    // ── Resolve handled_by (may arrive as JSON string in form-data)
    let handledByObj = {};
    if (typeof handled_by === "string") {
      try { handledByObj = JSON.parse(handled_by); } catch { handledByObj = {}; }
    } else {
      handledByObj = handled_by;
    }

    // ── Collect incoming S3 URL strings (JSON body path)
    let incomingUrls = [];
    if (Array.isArray(qc_images)) {
      incomingUrls = qc_images.filter(Boolean);
    } else if (typeof qc_images === "string") {
      try { incomingUrls = JSON.parse(qc_images).filter(Boolean); } catch { /* ignore */ }
    }

    // ── Collect any uploaded local files (multipart path — legacy / fallback)
    const uploadedFilePaths = (req.files || []).map((f) => `/uploads/qc/${f.filename}`);

    // ── Merge: keep existing + append new S3 URLs + append any local uploads
    const merged = [
      ...(job.qc_images || []),
      ...incomingUrls,
      ...uploadedFilePaths,
    ];
    // Deduplicate while preserving order
    job.qc_images = [...new Set(merged)];
    job.qc_notes  = qc_notes;

    if (handledByObj?.name) job.qc_inspected_by = handledByObj.name;

    const durationSecs = parseInt(duration_seconds, 10);
    if (durationSecs > 0) {
      job.qc_duration_seconds = durationSecs;
      job.qc_duration_display = duration_display;
    }

    await job.save();

    return resp(res, 200, true, "QC inspection data saved.", {
      qc_images:           job.qc_images,
      qc_notes:            job.qc_notes,
      qc_status:           job.qc_status,
      qc_duration_display: job.qc_duration_display,
    });
  } catch (err) {
    console.error("updateQC:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 19. PASS QC
// POST /api/jobs/:id/qc/pass
// Body: { handled_by, notes, next_stage?, next_assigned_to? }
// ─────────────────────────────────────────────────────────────────────────────
exports.passQC = async (req, res) => {
  try {
    const { handled_by, notes = "", next_stage, next_assigned_to } = req.body;

    if (!handled_by?.user_id || !handled_by?.name)
      return resp(res, 400, false, "handled_by.user_id and handled_by.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();

    // Close QC session if open
    if (job.hasOpenSession("quality_check"))
      job.closeSession({ stageName: "quality_check", action: "completed", notes });

    job.qc_status       = "passed";
    job.qc_inspected_by = handled_by.name;
    job.qc_inspected_at = now;
    if (notes) job.qc_notes = notes;

    if (next_stage) {
      const assignedTo = next_assigned_to || handled_by;
      job.workflow_stages.push({
        stage:         next_stage,
        stage_label:   next_stage,
        handled_by:    { user_id: assignedTo.user_id, name: assignedTo.name, role: assignedTo.role || "" },
        assigned_by:   { user_id: handled_by.user_id, name: handled_by.name },
        action:        "assigned",
        assigned_at:   now,
        work_sessions: [],
        notes:         `Passed QC → ${next_stage}`,
      });

      job.current_stage = {
        stage:                  next_stage,
        stage_label:            next_stage,
        stage_action:           "assigned",
        assigned_to: {
          user_id: assignedTo.user_id,
          name:    assignedTo.name,
          role:    assignedTo.role || "",
        },
        since:                  now,
        total_duration_seconds: 0,
        total_duration_display: "00:00:00",
        worked_days:            0,
      };
    } else {
      job.job_status = "passed";
    }

    job.status_updated_at = now;
    await job.save();

    const message = next_stage
      ? `QC passed. Job handed off to "${next_stage}".`
      : "QC passed. Job marked as passed.";

    return resp(res, 200, true, message, job);
  } catch (err) {
    console.error("passQC:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 20. FAIL QC
// POST /api/jobs/:id/qc/fail
// Body: { handled_by, reason, notes? }
// ─────────────────────────────────────────────────────────────────────────────
exports.failQC = async (req, res) => {
  try {
    const { handled_by, reason, notes = "" } = req.body;

    if (!handled_by?.user_id || !handled_by?.name)
      return resp(res, 400, false, "handled_by.user_id and handled_by.name are required.");
    if (!reason?.trim())
      return resp(res, 400, false, "A rejection reason is required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();

    if (job.hasOpenSession("quality_check")) {
      job.closeSession({ stageName: "quality_check", action: "failed", notes });
    } else {
      const stageEntry = job.getActiveStage("quality_check");
      if (stageEntry) {
        stageEntry.action       = "failed";
        stageEntry.completed_at = now;
      }
      job.job_status        = "failed";
      job.status_updated_at = now;
    }

    job.qc_status           = "failed";
    job.qc_rejection_reason = reason;
    job.qc_inspected_by     = handled_by.name;
    job.qc_inspected_at     = now;
    if (notes) job.qc_notes = notes;

    await job.save();
    return resp(res, 200, true, "QC failed. Rejection reason recorded.", {
      qc_status:           job.qc_status,
      qc_rejection_reason: job.qc_rejection_reason,
      job_status:          job.job_status,
    });
  } catch (err) {
    console.error("failQC:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 21. GET WORKFLOW HISTORY
// GET /api/jobs/:id/workflow
// ─────────────────────────────────────────────────────────────────────────────
exports.getWorkflowHistory = async (req, res) => {
  try {
    const job = await Job.getWorkflowHistory(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const stageSummary = {};
    for (const entry of job.workflow_stages) {
      stageSummary[entry.stage] = {
        action:                 entry.action,
        total_sessions:         entry.work_sessions?.length || 0,
        total_duration_seconds: entry.total_duration_seconds || 0,
        total_duration_display: entry.total_duration_display || "00:00:00",
        worked_days:            entry.worked_days || 0,
        daily_summary:          entry.daily_summary || [],
      };
    }

    return resp(res, 200, true, "Workflow history fetched.", {
      job_no:          job.job_no,
      job_status:      job.job_status,
      current_stage:   job.current_stage,
      workflow_stages: job.workflow_stages,
      stage_summary:   stageSummary,
    });
  } catch (err) {
    console.error("getWorkflowHistory:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 22. GET JOBS ASSIGNED TO A SPECIFIC USER
// GET /api/jobs/assigned-to/:userId
// ─────────────────────────────────────────────────────────────────────────────
exports.getJobsAssignedToUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId))
      return resp(res, 400, false, "Invalid userId.");

    const filter = {
      "current_stage.assigned_to.user_id": new mongoose.Types.ObjectId(userId),
    };
    if (status) filter.job_status = status;

    const jobs = await Job.find(filter)
      .select("-workflow_stages")
      .sort({ "current_stage.since": -1 })
      .lean();

    return resp(res, 200, true, "Jobs fetched successfully.", jobs);
  } catch (err) {
    console.error("getJobsAssignedToUser:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 23. CONVERT JOB TO ORDER
// POST /api/jobs/:id/convert
// ─────────────────────────────────────────────────────────────────────────────
exports.convertToOrder = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.converted_to_order)
      return resp(res, 400, false, "Job has already been converted.");
    if (job.job_status === "expired")
      return resp(res, 400, false, "Expired jobs cannot be converted.");

    job.converted_to_order = true;
    job.converted_at       = new Date();
    job.job_status         = "converted";
    job.status_updated_at  = new Date();
    await job.save();

    return resp(res, 200, true, "Job converted to order successfully.", {
      job_id:       job._id,
      job_no:       job.job_no,
      converted_at: job.converted_at,
    });
  } catch (err) {
    console.error("convertToOrder:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 24. DELETE JOB (soft delete)
// DELETE /api/jobs/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteJob = async (req, res) => {
  try {
    const { delete_notes, adminId } = req.body;

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.deletedAt     = new Date();
    job.deleted_notes = delete_notes || "";
    if (adminId) job.deleted_by = adminId;
    await job.save();

    return resp(res, 200, true, "Job soft-deleted successfully.");
  } catch (err) {
    console.error("deleteJob:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 25. RESTORE JOB
// POST /api/jobs/:id/restore
// ─────────────────────────────────────────────────────────────────────────────
exports.restoreJob = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).includeDeleted();
    if (!job) return resp(res, 404, false, "Job not found.");

    job.deletedAt     = null;
    job.deleted_notes = "";
    await job.save();

    return resp(res, 200, true, "Job restored successfully.");
  } catch (err) {
    console.error("restoreJob:", err);
    return resp(res, 500, false, err.message);
  }
};