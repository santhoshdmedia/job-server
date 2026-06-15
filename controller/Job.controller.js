// ==================== JOB CONTROLLER (v2) ====================
// RULE: openSession / closeSession NEVER touch job_status.
//
// KEY CHANGES:
//  • addItemDesignFiles   → each file can carry assigned_to + work_status
//  • assignDesignFile     → POST /jobs/:id/items/:itemId/files/:fileId/assign
//  • approveDesignFile    → POST /jobs/:id/items/:itemId/files/:fileId/approve
//  • rejectDesignFile     → POST /jobs/:id/items/:itemId/files/:fileId/reject
//  • updateFileWorkStatus → PATCH /jobs/:id/items/:itemId/files/:fileId/status
//  • linkFileMaterialIssue → PATCH /jobs/:id/items/:itemId/files/:fileId/material
//  • getDesignSummary     → per-file breakdown including assignee + issue link

const mongoose   = require("mongoose");
const Job        = require("../modals/job.modal");
const AdminUsers = require("../modals/adminusers.modals");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const generateJobNo = async () => {
  const prefix = "DM";
  const last   = await Job.findOne({ job_no: new RegExp(`^${prefix}\\d+$`) })
    .sort({ job_no: -1 }).select("job_no").lean();
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
    const {
      customer_name, customer_phone, company_name,
      order_no, order_date, estimated_delivery_date,
      cart_items, delivery_address, job_status,
      subtotal, discount_percentage, discount_amount,
      taxable_amount, tax_amount, delivery_charges, free_delivery,
      total_amount, gst_no, payment_mode, payment_amount, balance_amount,
      design_charges, valid_until, notes, terms_and_conditions,
      created_by, created_by_admin_id,
      site_visit_id, site_visit_no, site_visit_photos        
    } = req.body;

    const job_no = await generateJobNo();

    const processedItems = (cart_items || []).map(item => ({
      ...item,
      item_id:       item.item_id || new mongoose.Types.ObjectId().toHexString(),
      design_files:  item.design_files  || [],
      design_status: item.design_status || "pending",
      designers:     item.designers     || [],
    }));

    const jobData = await Job.create({
      job_no, order_no: order_no || "",
      customer_name: customer_name || "", customer_phone: customer_phone || "",
      company_name: company_name || "",
      order_date:              order_date              ? new Date(order_date)              : null,
      estimated_delivery_date: estimated_delivery_date ? new Date(estimated_delivery_date) : null,
      cart_items: processedItems, delivery_address: delivery_address || {},
      job_status: job_status || "draft", status_updated_at: new Date(),
      subtotal:            parseFloat(subtotal)            || 0,
      discount_percentage: parseFloat(discount_percentage) || 0,
      discount_amount:     parseFloat(discount_amount)     || 0,
      taxable_amount:      parseFloat(taxable_amount)      || 0,
      tax_amount:          parseFloat(tax_amount)          || 0,
      delivery_charges:    parseFloat(delivery_charges)    || 0,
      free_delivery:       free_delivery ?? false,
      total_amount:        parseFloat(total_amount),
      gst_no:              gst_no || "",
      payment_mode:        payment_mode || "",
      payment_amount:      parseFloat(payment_amount) || 0,
      balance_amount:      parseFloat(balance_amount) || 0,
      design_charges:      parseFloat(design_charges)  || 0,
      valid_until:         new Date(valid_until),
      notes:               notes || "", terms_and_conditions: terms_and_conditions || "",
      created_by:          created_by || "admin",
      created_by_admin_id: created_by_admin_id || null,
      converted_to_order:  false, deletedAt: null,

      // ← ADD THESE TWO LINES
      site_visit_id: site_visit_id || null,
      site_visit_no: site_visit_no || "",
      site_visit_photos: site_visit_photos || [],
    });

    console.log("createJob ✅ | job_no:", jobData.job_no);
    return res.status(201).json({ success: true, message: "Job created successfully.", job: jobData, data: jobData });
  } catch (err) {
    console.error("createJob ❌", err);
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
    const { status, stage, customer_name, job_no, page = 1, limit = 20, sort_by = "createdAt", sort_order = "desc" } = req.query;

    const filter = {};
    if (status)        filter.job_status = status;
    if (stage)         filter["current_stage.stage"] = stage;
    if (customer_name) filter.customer_name = new RegExp(customer_name, "i");
    if (job_no)        filter.job_no = new RegExp(job_no, "i");

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const sort  = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total = await Job.countDocuments(filter);
    const jobs  = await Job.find(filter).sort(sort).skip(skip).limit(parseInt(limit)).select("-workflow_stages").lean();

    return resp(res, 200, true, "Jobs fetched successfully.", {
      jobs,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error("getAllJobs ❌", err);
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
      .populate("workflow_stages.handled_by.user_id",        "name role email")
      .populate("workflow_stages.assigned_by.user_id",       "name role")
      .populate("workflow_stages.work_sessions.user_id",     "name role email")
      .populate("current_stage.assigned_to.user_id",         "name role email")
      .populate("cart_items.designers.user_id",              "name role email")
      .populate("cart_items.design_files.assigned_to.user_id","name role email")
      .populate("cart_items.design_files.material_issue_id",  "issue_no issued_qty status calculation")
      .lean();

    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, "Job fetched successfully.", job);
  } catch (err) {
    console.error("getJobById ❌", err);
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
      "customer_name", "customer_phone", "company_name", "cart_items",
      "delivery_address", "estimated_delivery_date", "order_date",
      "subtotal", "discount_percentage", "discount_amount", "taxable_amount",
      "tax_amount", "delivery_charges", "free_delivery", "total_amount",
      "gst_no", "valid_until", "notes", "terms_and_conditions",
      "payment_amount", "payment_mode", "balance_amount",
    ];
    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length)
      return resp(res, 400, false, "No valid fields provided to update.");

    const job = await Job.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true, runValidators: true }).lean();
    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, "Job updated successfully.", job);
  } catch (err) {
    console.error("updateJob ❌", err);
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
    if (!job_status) return resp(res, 400, false, "job_status is required.");
    const job = await Job.findByIdAndUpdate(
      req.params.id, { $set: { job_status, status_updated_at: new Date() } }, { new: true }
    ).lean();
    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, `Job status updated to "${job_status}".`, job);
  } catch (err) {
    console.error("updateJobStatus ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. APPROVE JOB
// POST /api/jobs/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
exports.approveJob = async (req, res) => {
  try {
    const { approved_by, approved_by_admin_id, assign_to, job_status } = req.body;
    if (!approved_by || !approved_by_admin_id) return resp(res, 400, false, "Approver name and ID are required.");
    if (!assign_to?.user_id) return resp(res, 400, false, "A designer must be assigned when approving.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const designer = await AdminUsers.findById(assign_to.user_id);
    if (!designer || designer.role !== "designing team")
      return resp(res, 400, false, "Selected user is not a valid designer.");

    const now = new Date();
    job.job_status = job_status || "accepted";
    job.approved_by = approved_by; job.approved_by_admin_id = approved_by_admin_id;
    job.status_updated_at = now;

    job.workflow_stages.push({
      stage: "design", stage_label: "Design",
      handled_by:  { user_id: designer._id, name: designer.name, role: designer.role },
      assigned_by: { user_id: approved_by_admin_id, name: approved_by },
      action: "assigned", assigned_at: now, work_sessions: [],
      notes: "Job approved and assigned by admin",
    });
    job.current_stage = {
      stage: "design", stage_label: "Design", stage_action: "assigned",
      assigned_to: { user_id: designer._id, name: designer.name, role: designer.role }, since: now,
    };

    await job.save();
    return resp(res, 200, true, `Job approved and assigned to ${designer.name}.`, job);
  } catch (err) {
    console.error("approveJob ❌", err);
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
    if (!assigned_to?.user_id || !assigned_to?.name) return resp(res, 400, false, "assigned_to.user_id and assigned_to.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.workflow_stages.push({
      stage, stage_label: stage_label || "",
      handled_by:  { user_id: assigned_to.user_id, name: assigned_to.name, role: assigned_to.role || "" },
      assigned_by: assigned_by || {},
      action: "assigned", assigned_at: now, work_sessions: [], notes: notes || "",
    });
    job.current_stage = {
      stage, stage_label: stage_label || "", stage_action: "assigned",
      assigned_to: { user_id: assigned_to.user_id, name: assigned_to.name, role: assigned_to.role || "" },
      since: now,
    };
    job.status_updated_at = now;

    await job.save();
    return resp(res, 200, true, `Job assigned to ${assigned_to.name} at stage "${stage}".`, job);
  } catch (err) {
    console.error("assignJob ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. OPEN SESSION  POST /api/jobs/:id/session/open
// ─────────────────────────────────────────────────────────────────────────────
exports.openSession = async (req, res) => {
  try {
    const { stage, stage_label, user, notes } = req.body;
    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!user?.user_id || !user?.name) return resp(res, 400, false, "user.user_id and user.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.hasOpenSession(stage))
      return resp(res, 409, false, `A session for stage "${stage}" is already open.`);

    job.openSession({ stageName: stage, stageLabel: stage_label, user, notes });
    await job.save();
    return resp(res, 200, true, `Session opened for stage "${stage}".`, { job_no: job.job_no, stage_summary: job.getSessionSummary(stage) });
  } catch (err) {
    console.error("openSession ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLOSE SESSION  POST /api/jobs/:id/session/close
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
      on_hold:   `Session paused. Worked ${summary.total_duration_display} so far.`,
      completed: `Stage completed! Total time: ${summary.total_duration_display}.`,
      rejected:  `Stage rejected. Time logged: ${summary.total_duration_display}.`,
      passed:    `Stage passed. Time logged: ${summary.total_duration_display}.`,
    };
    return resp(res, 200, true, msgs[action] || `Session closed with action "${action}".`, { job_no: job.job_no, stage_summary: summary });
  } catch (err) {
    console.error("closeSession ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET SESSION STATUS  GET /api/jobs/:id/session/status?stage=design
// ─────────────────────────────────────────────────────────────────────────────
exports.getSessionStatus = async (req, res) => {
  try {
    const { stage } = req.query;
    const job = await Job.findById(req.params.id).select("job_no job_status current_stage workflow_stages").lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    const workflowStages = Array.isArray(job.workflow_stages) ? job.workflow_stages : [];

    if (stage) {
      const stageEntry  = workflowStages.find(s => s.stage === stage);
      if (!stageEntry)  return resp(res, 200, true, "Session status fetched.", { job_no: job.job_no, stage, has_open_session: false, total_sessions: 0 });

      const sessions    = Array.isArray(stageEntry.work_sessions) ? stageEntry.work_sessions : [];
      const openSession = sessions.find(s => !s.session_end);
      return resp(res, 200, true, "Session status fetched.", {
        job_no: job.job_no, stage, stage_action: stageEntry.action,
        has_open_session: !!openSession, open_since: openSession?.session_start || null,
        total_sessions: sessions.length,
        total_duration_seconds: stageEntry.total_duration_seconds || 0,
        total_duration_display: stageEntry.total_duration_display || "00:00:00",
        worked_days: stageEntry.worked_days || 0, daily_summary: stageEntry.daily_summary || [],
      });
    }

    const stageSummaries = workflowStages.map(s => {
      const sessions = Array.isArray(s.work_sessions) ? s.work_sessions : [];
      return {
        stage: s.stage, action: s.action,
        has_open_session: sessions.some(x => !x.session_end),
        total_duration_display: s.total_duration_display || "00:00:00",
      };
    });

    return resp(res, 200, true, "All stage session statuses fetched.", { job_no: job.job_no, current_stage: job.current_stage, stages: stageSummaries });
  } catch (err) {
    console.error("getSessionStatus ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 11–14. startJob / completeStage / holdJob / rejectJob (unchanged logic)
// ─────────────────────────────────────────────────────────────────────────────
exports.startJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;
    if (!stage || !handled_by?.user_id || !handled_by?.name)
      return resp(res, 400, false, "stage and handled_by are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.hasOpenSession(stage))
      return resp(res, 409, false, `A session for stage "${stage}" is already open.`);

    job.openSession({ stageName: stage, user: { user_id: handled_by.user_id, name: handled_by.name, role: handled_by.role || "" }, notes });
    await job.save();
    return resp(res, 200, true, `Session started for stage "${stage}".`, { stage_summary: job.getSessionSummary(stage) });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.completeStage = async (req, res) => {
  try {
    const { stage, handled_by, notes, next_stage, next_assigned_to } = req.body;
    if (!stage || !handled_by?.user_id) return resp(res, 400, false, "stage and handled_by are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    if (job.getActiveStage(stage)) job.closeSession({ stageName: stage, action: "completed", notes });

    if (next_stage) {
      const assignedTo = next_assigned_to || handled_by;
      job.workflow_stages.push({
        stage: next_stage, stage_label: "",
        handled_by:  { user_id: assignedTo.user_id, name: assignedTo.name, role: assignedTo.role || "" },
        assigned_by: { user_id: handled_by.user_id, name: handled_by.name },
        action: "assigned", assigned_at: now, work_sessions: [],
      });
      job.current_stage = {
        stage: next_stage, stage_action: "assigned",
        assigned_to: { user_id: assignedTo.user_id, name: assignedTo.name, role: assignedTo.role || "" },
        since: now,
      };
    } else {
      job.job_status = "completed"; job.status_updated_at = now;
    }

    await job.save();
    return resp(res, 200, true, next_stage ? `Stage "${stage}" → "${next_stage}".` : `Stage "${stage}" completed.`, job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.holdJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;
    if (!stage || !handled_by?.user_id) return resp(res, 400, false, "stage and handled_by are required.");
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.hasOpenSession(stage)) job.closeSession({ stageName: stage, action: "on_hold", notes });
    else { const s = job.getActiveStage(stage); if (s) s.action = "on_hold"; }
    await job.save();
    return resp(res, 200, true, "Job session placed on hold.", { job_no: job.job_no });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.rejectJob = async (req, res) => {
  try {
    const { stage, handled_by, notes } = req.body;
    if (!stage || !handled_by?.user_id) return resp(res, 400, false, "stage and handled_by are required.");
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.hasOpenSession(stage)) job.closeSession({ stageName: stage, action: "rejected", notes });
    else { const s = job.getActiveStage(stage); if (s) { s.action = "rejected"; s.completed_at = new Date(); } }
    await job.save();
    return resp(res, 200, true, "Job stage rejected.", { job_no: job.job_no });
  } catch (err) { return resp(res, 500, false, err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. UPLOAD DESIGN FILE (job-level / legacy)
// POST /api/jobs/:id/upload_design
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadDesign = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const {
      notes = "", duration_seconds = 0, duration_display = "00:00:00",
      design_file = "", design_drive_link = "",
      stage = job.current_stage?.stage || "design", handled_by = {}, is_sample = false,
    } = req.body;

    const handledByObj = typeof handled_by === "string" ? JSON.parse(handled_by) : handled_by;
    if (!design_file && !design_drive_link)
      return resp(res, 400, false, "A design file path or Drive link is required.");

    job.design_file            = design_file || job.design_file;
    job.design_drive_link      = design_drive_link || job.design_drive_link;
    job.design_uploaded_at     = new Date();
    job.design_uploaded_by     = handledByObj.name || "";
    job.design_duration_seconds = parseInt(duration_seconds, 10) || 0;
    job.design_duration_display = duration_display;
    job.design_is_sample       = is_sample === true || is_sample === "true";

    const hasItemDesigns = job.cart_items.some(i => i.design_files?.length > 0);
    if (!hasItemDesigns) job.design_status = "uploaded";

    if (job.hasOpenSession(stage)) job.closeSession({ stageName: stage, action: "completed", notes });
    await job.save();

    return resp(res, 200, true, "Design uploaded.", { design_file: job.design_file, design_status: job.design_status });
  } catch (err) {
    console.error("uploadDesign ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 16. APPROVE / REJECT DESIGN (job-level)
// ─────────────────────────────────────────────────────────────────────────────
exports.approveDesign = async (req, res) => {
  try {
    const { handled_by, design_file, drive_link, notes } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.design_status      = "approved";
    job.design_approved_at = new Date();
    job.design_approved_by = handled_by?.user_id || "Admin";
    if (design_file) job.design_file       = design_file;
    if (drive_link)  job.design_drive_link = drive_link;
    if (notes)       job.notes             = notes;

    await job.save();
    return resp(res, 200, true, "Design approved.", { design_status: job.design_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.approveProduction = async (req, res) => {
  try {
    const { handled_by, productionimg } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.production_status = "production_completed"; job.production_approved_at = new Date();
    job.production_approved_by = handled_by?.user_id || "Admin";
    if (productionimg) job.productionimg = productionimg;
    await job.save();
    return resp(res, 200, true, "Production approved.", { production_status: job.production_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.approveqc = async (req, res) => {
  try {
    const { handled_by, qcimg } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.qc_status = "qc_completed"; job.qc_approved_at = new Date();
    job.qc_approved_by = handled_by?.user_id || "Admin";
    if (qcimg) job.qcimg = qcimg;
    await job.save();
    return resp(res, 200, true, "QC approved.", { qc_status: job.qc_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.rejectDesign = async (req, res) => {
  try {
    const { notes } = req.body;
    if (!notes?.trim()) return resp(res, 400, false, "Rejection reason is required.");
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.design_status = "rejected"; job.design_rejection_reason = notes;
    await job.save();
    return resp(res, 200, true, "Design rejected.", { design_status: job.design_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 17–21. QC / passQC / failQC / getWorkflowHistory / getJobsAssignedToUser /
//        convertToOrder / deleteJob / restoreJob (unchanged logic — kept verbatim)
// ─────────────────────────────────────────────────────────────────────────────
exports.updateQC = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    const { qc_notes = "", duration_seconds = 0, duration_display = "00:00:00", qc_images = [], handled_by = {} } = req.body;
    const handledByObj = typeof handled_by === "string" ? JSON.parse(handled_by) : handled_by;
    const incomingUrls = Array.isArray(qc_images) ? qc_images.filter(Boolean) : [];
    const uploadedFilePaths = (req.files || []).map(f => `/uploads/qc/${f.filename}`);
    job.qc_images = [...new Set([...(job.qc_images || []), ...incomingUrls, ...uploadedFilePaths])];
    job.qc_notes = qc_notes;
    if (handledByObj?.name) job.qc_inspected_by = handledByObj.name;
    const durationSecs = parseInt(duration_seconds, 10);
    if (durationSecs > 0) { job.qc_duration_seconds = durationSecs; job.qc_duration_display = duration_display; }
    await job.save();
    return resp(res, 200, true, "QC data saved.", { qc_images: job.qc_images, qc_status: job.qc_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.passQC = async (req, res) => {
  try {
    const { handled_by, notes = "", next_stage, next_assigned_to } = req.body;
    if (!handled_by?.user_id || !handled_by?.name) return resp(res, 400, false, "handled_by is required.");
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    const now = new Date();
    if (job.hasOpenSession("quality_check")) job.closeSession({ stageName: "quality_check", action: "completed", notes });
    job.qc_status = "passed"; job.qc_inspected_by = handled_by.name; job.qc_inspected_at = now;
    if (notes) job.qc_notes = notes;
    if (next_stage) {
      const assignedTo = next_assigned_to || handled_by;
      job.workflow_stages.push({ stage: next_stage, stage_label: next_stage, handled_by: assignedTo, assigned_by: handled_by, action: "assigned", assigned_at: now, work_sessions: [] });
      job.current_stage = { stage: next_stage, stage_label: next_stage, stage_action: "assigned", assigned_to: assignedTo, since: now };
    } else { job.job_status = "passed"; job.status_updated_at = now; }
    await job.save();
    return resp(res, 200, true, next_stage ? `QC passed → "${next_stage}".` : "QC passed.", job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.failQC = async (req, res) => {
  try {
    const { handled_by, reason, notes = "" } = req.body;
    if (!handled_by?.user_id || !handled_by?.name) return resp(res, 400, false, "handled_by is required.");
    if (!reason?.trim()) return resp(res, 400, false, "Rejection reason is required.");
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    const now = new Date();
    if (job.hasOpenSession("quality_check")) job.closeSession({ stageName: "quality_check", action: "failed", notes });
    else { const s = job.getActiveStage("quality_check"); if (s) { s.action = "failed"; s.completed_at = now; } }
    job.job_status = "failed"; job.status_updated_at = now;
    job.qc_status = "failed"; job.qc_rejection_reason = reason;
    job.qc_inspected_by = handled_by.name; job.qc_inspected_at = now;
    if (notes) job.qc_notes = notes;
    await job.save();
    return resp(res, 200, true, "QC failed.", { qc_status: job.qc_status, job_status: job.job_status });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.getWorkflowHistory = async (req, res) => {
  try {
    const job = await Job.getWorkflowHistory(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    const stageSummary = {};
    for (const entry of job.workflow_stages) {
      stageSummary[entry.stage] = { action: entry.action, total_duration_display: entry.total_duration_display || "00:00:00" };
    }
    return resp(res, 200, true, "Workflow history fetched.", { job_no: job.job_no, job_status: job.job_status, current_stage: job.current_stage, workflow_stages: job.workflow_stages, stage_summary: stageSummary });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.getJobsAssignedToUser = async (req, res) => {
  try {
    const { userId } = req.params; const { status } = req.query;
    if (!mongoose.Types.ObjectId.isValid(userId)) return resp(res, 400, false, "Invalid userId.");
    const filter = { "current_stage.assigned_to.user_id": new mongoose.Types.ObjectId(userId) };
    if (status) filter.job_status = status;
    const jobs = await Job.find(filter).select("-workflow_stages").sort({ "current_stage.since": -1 }).lean();
    return resp(res, 200, true, "Jobs fetched.", jobs);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.convertToOrder = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.converted_to_order) return resp(res, 400, false, "Already converted.");
    if (job.job_status === "expired") return resp(res, 400, false, "Expired jobs cannot be converted.");
    const now = new Date();
    job.converted_to_order = true; job.converted_at = now;
    job.job_status = "converted"; job.status_updated_at = now;
    await job.save();
    return resp(res, 200, true, "Job converted to order.", { job_id: job._id, job_no: job.job_no });
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.deleteJob = async (req, res) => {
  try {
    const { delete_notes, adminId } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.deletedAt = new Date(); job.deleted_notes = delete_notes || "";
    if (adminId) job.deleted_by = adminId;
    await job.save();
    return resp(res, 200, true, "Job soft-deleted.");
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.restoreJob = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).includeDeleted();
    if (!job) return resp(res, 404, false, "Job not found.");
    job.deletedAt = null; job.deleted_notes = "";
    await job.save();
    return resp(res, 200, true, "Job restored.");
  } catch (err) { return resp(res, 500, false, err.message); }
};

// ═════════════════════════════════════════════════════════════════════════════
//  PER-ITEM DESIGN FILE ENDPOINTS  (NEW / ENHANCED in v2)
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// 26. ADD DESIGN FILES TO A CART ITEM
// POST /api/jobs/:id/items/:itemId/design-files
//
// Body:
// {
//   files: [{
//     url, file_name, file_type, label, caption,
//     assigned_to?: { user_id, name, role },   ← per-file assignee
//     work_status?: "pending"|"in_progress"
//   }],
//   handled_by: { user_id, name }
// }
//
// Each file is a discrete work unit that can be assigned to a different person
// and have its own material issue.
// ─────────────────────────────────────────────────────────────────────────────
exports.addItemDesignFiles = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { files, handled_by = {} } = req.body;

    if (!Array.isArray(files) || !files.length)
      return resp(res, 400, false, "files array is required.");

    const validFiles = files.filter(f => f?.url);
    if (!validFiles.length) return resp(res, 400, false, "Each file entry must have a url.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.addItemDesignFiles(itemId, validFiles, handled_by);
    await job.save();

    const item = job.findCartItem(itemId);
    return resp(res, 200, true, `${validFiles.length} design file(s) added.`, {
      item_id:      itemId,
      design_files: item.design_files,
      design_status: item.design_status,
    });
  } catch (err) {
    console.error("addItemDesignFiles ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 27. ASSIGN A SPECIFIC DESIGN FILE TO A PERSON
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/assign
//
// Body: { assigned_to: { user_id, name, role } }
// ─────────────────────────────────────────────────────────────────────────────
exports.assignDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { assigned_to } = req.body;

    if (!assigned_to?.name) return resp(res, 400, false, "assigned_to.name is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const file = job.assignDesignFile(itemId, fileId, assigned_to);
    await job.save();

    return resp(res, 200, true, `Design file assigned to ${assigned_to.name}.`, {
      file_id:     fileId,
      assigned_to: file.assigned_to,
    });
  } catch (err) {
    console.error("assignDesignFile ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 28. UPDATE WORK STATUS FOR A SPECIFIC DESIGN FILE
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/status
//
// Body: { work_status: "pending"|"in_progress"|"completed"|"approved"|"rejected", work_notes? }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateFileWorkStatus = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { work_status, work_notes = "" } = req.body;

    const allowed = ["pending", "in_progress", "completed", "approved", "rejected"];
    if (!work_status || !allowed.includes(work_status))
      return resp(res, 400, false, `work_status must be one of: ${allowed.join(", ")}`);

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.updateFileWorkStatus(itemId, fileId, work_status, work_notes);
    await job.save();

    const item = job.findCartItem(itemId);
    return resp(res, 200, true, `File work status updated to "${work_status}".`, {
      file_id:       fileId,
      work_status,
      item_design_status: item.design_status,
    });
  } catch (err) {
    console.error("updateFileWorkStatus ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 29. APPROVE A SPECIFIC DESIGN FILE
// POST /api/jobs/:id/items/:itemId/design-files/:fileId/approve
//
// Body: { handled_by: { user_id, name } }
// ─────────────────────────────────────────────────────────────────────────────
exports.approveDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { handled_by = {} } = req.body;

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.approveDesignFile(itemId, fileId, handled_by);
    await job.save();

    const item = job.findCartItem(itemId);
    const allApproved = item.design_files.every(f => f.work_status === "approved");

    return resp(res, 200, true,
      allApproved ? "File approved. All files on this item are now approved!" : "Design file approved.",
      { file_id: fileId, item_design_status: item.design_status, job_design_status: job.design_status }
    );
  } catch (err) {
    console.error("approveDesignFile ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 30. REJECT A SPECIFIC DESIGN FILE
// POST /api/jobs/:id/items/:itemId/design-files/:fileId/reject
//
// Body: { handled_by: { user_id, name }, notes: "reason" }
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { handled_by = {}, notes = "" } = req.body;

    if (!notes?.trim()) return resp(res, 400, false, "Rejection reason (notes) is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.rejectDesignFile(itemId, fileId, notes, handled_by);
    await job.save();

    const item = job.findCartItem(itemId);
    return resp(res, 200, true, "Design file rejected.", {
      file_id: fileId, item_design_status: item.design_status,
    });
  } catch (err) {
    console.error("rejectDesignFile ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 31. LINK A MATERIAL ISSUE TO A SPECIFIC DESIGN FILE
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/material
//
// Body: { material_issue_id: "..." }
// Called automatically by material_issue controller but exposed for manual use.
// ─────────────────────────────────────────────────────────────────────────────
exports.linkFileMaterialIssue = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { material_issue_id } = req.body;

    if (!material_issue_id) return resp(res, 400, false, "material_issue_id is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    job.linkMaterialIssue(itemId, fileId, material_issue_id);
    await job.save();

    return resp(res, 200, true, "Material issue linked to design file.", { file_id: fileId, material_issue_id });
  } catch (err) {
    console.error("linkFileMaterialIssue ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 32. REMOVE A DESIGN FILE FROM A CART ITEM
// DELETE /api/jobs/:id/items/:itemId/design-files/:fileId
// ─────────────────────────────────────────────────────────────────────────────
exports.removeItemDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.removeItemDesignFile(itemId, fileId);
    await job.save();
    return resp(res, 200, true, "Design file removed.", job);
  } catch (err) {
    console.error("removeItemDesignFile ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 33. APPROVE / REJECT ITEM DESIGN (all files at once)
// POST /api/jobs/:id/items/:itemId/approve-design
// POST /api/jobs/:id/items/:itemId/reject-design
// ─────────────────────────────────────────────────────────────────────────────
exports.approveItemDesign = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { handled_by = {} } = req.body;
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.approveItemDesign(itemId, handled_by);
    await job.save();
    const allApproved = job.cart_items.every(i => i.design_status === "approved");
    return resp(res, 200, true, allApproved ? "All items approved!" : "Item design approved.", job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.rejectItemDesign = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { handled_by = {}, notes = "" } = req.body;
    if (!notes?.trim()) return resp(res, 400, false, "Rejection reason is required.");
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.rejectItemDesign(itemId, notes, handled_by);
    await job.save();
    return resp(res, 200, true, "Item design rejected.", job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 34. ASSIGN DESIGNERS TO A CART ITEM (item pool, not per-file)
// POST /api/jobs/:id/items/:itemId/assign-designers
// ─────────────────────────────────────────────────────────────────────────────
exports.assignItemDesigners = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { designers = [], assigned_by = {} } = req.body;
    if (!Array.isArray(designers) || !designers.length)
      return resp(res, 400, false, "designers array is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    for (const d of designers) {
      if (!d.user_id || !mongoose.Types.ObjectId.isValid(d.user_id)) continue;
      const user = await AdminUsers.findById(d.user_id).select("name role").lean();
      if (user) { if (!d.name) d.name = user.name; if (!d.role) d.role = user.role; }
    }

    job.assignItemDesigners(itemId, designers, assigned_by);
    await job.save();
    return resp(res, 200, true, `${designers.length} designer(s) assigned to item.`, job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.removeItemDesigner = async (req, res) => {
  try {
    const { id, itemId, designerUserId } = req.params;
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.removeItemDesigner(itemId, designerUserId);
    await job.save();
    return resp(res, 200, true, "Designer removed from item.", job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

exports.updateItemDesignerStatus = async (req, res) => {
  try {
    const { id, itemId, designerUserId } = req.params;
    const { status, notes = "" } = req.body;
    const allowed = ["assigned", "in_progress", "uploaded", "approved", "rejected"];
    if (!status || !allowed.includes(status)) return resp(res, 400, false, `status must be one of: ${allowed.join(", ")}`);
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");
    job.updateItemDesignerStatus(itemId, designerUserId, status, notes);
    await job.save();
    return resp(res, 200, true, `Designer status → "${status}".`, job);
  } catch (err) { return resp(res, 500, false, err.message); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 35. GET DESIGN SUMMARY (per-file breakdown with assignee + material issue)
// GET /api/jobs/:id/design-summary
// ─────────────────────────────────────────────────────────────────────────────
exports.getDesignSummary = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select("job_no job_status design_status design_drive_link cart_items")
      .populate("cart_items.design_files.assigned_to.user_id",  "name role email")
      .populate("cart_items.design_files.material_issue_id",     "issue_no issued_qty status calc_mode calculation printing_dimensions media_dimensions")
      .lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    const items = (job.cart_items || []).map(item => {
      const files        = item.design_files || [];
      const totalFiles   = files.length;
      const approvedFiles = files.filter(f => f.work_status === "approved").length;
      const rejectedFiles = files.filter(f => f.work_status === "rejected").length;
      const inProgFiles  = files.filter(f => ["in_progress", "completed"].includes(f.work_status)).length;

      return {
        item_id:       item.item_id,
        product_name:  item.product_name,
        variation:     item.variation,
        size:          item.size,
        quantity:      item.quantity,
        quantity_type: item.quantity_type,
        design_status: item.design_status || "pending",
        design_rejection_reason: item.design_rejection_reason || "",
        design_approved_at: item.design_approved_at,
        // Per-file breakdown — core of v2
        files_summary: { total: totalFiles, approved: approvedFiles, rejected: rejectedFiles, in_progress: inProgFiles, pending: totalFiles - approvedFiles - rejectedFiles - inProgFiles },
        design_files: files.map(f => ({
          _id:              f._id,
          url:              f.url,
          file_name:        f.file_name,
          file_type:        f.file_type,
          label:            f.label,
          caption:          f.caption,
          uploaded_at:      f.uploaded_at,
          uploaded_by:      f.uploaded_by,
          assigned_to:      f.assigned_to,         // per-file assignee
          work_status:      f.work_status,
          work_notes:       f.work_notes,
          approved_at:      f.approved_at,
          rejection_reason: f.rejection_reason,
          material_issue:   f.material_issue_id,   // populated issue
        })),
        designers: item.designers || [],
      };
    });

    const total    = items.length;
    const approved = items.filter(i => i.design_status === "approved").length;
    const partial  = items.filter(i => ["in_progress", "partial"].includes(i.design_status)).length;
    const rejected = items.filter(i => i.design_status === "rejected").length;
    const pending  = items.filter(i => i.design_status === "pending").length;

    return resp(res, 200, true, "Design summary fetched.", {
      job_no: job.job_no, job_design_status: job.design_status,
      design_drive_link: job.design_drive_link,
      summary: { total, approved, partial, rejected, pending },
      items,
    });
  } catch (err) {
    console.error("getDesignSummary ❌", err);
    return resp(res, 500, false, err.message);
  }
};