const mongoose = require("mongoose");
const Job = require("../modals/job.modal");
const AdminUsers = require("../modals/adminusers.modals");
const MaterialIssue = require("../modals/Material_issue.model");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Response Formatter
// ─────────────────────────────────────────────────────────────────────────────
const resp = (res, status, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null) payload.data = data;
  return res.status(status).json(payload);
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Return a plain lean copy of a saved Mongoose doc
// Always use this before sending a job in any response so the frontend
// gets a consistent plain object — never a Mongoose document proxy.
// ─────────────────────────────────────────────────────────────────────────────
const toPlain = (doc) => {
  if (!doc) return null;
  if (typeof doc.toObject === "function") return doc.toObject();
  return doc;
};

// ─────────────────────────────────────────────────────────────────────────────
// ✅ Helper: Role guard
// Normal designers ("designing team") can upload files, but assigning,
// reassigning, approving, and rejecting design work is an admin/superadmin
// action only. This is a best-effort, backward-compatible check — if a caller
// doesn't send `handled_by.role` (older clients), the request is still
// allowed through so nothing existing breaks. Any caller that DOES send a
// role is held to it.
// ─────────────────────────────────────────────────────────────────────────────
const MANAGER_ROLES = ["admin", "super admin","designing team"];
const isManagerRole = (role) => MANAGER_ROLES.includes(String(role || "").toLowerCase().trim());

const requireManagerRole = (res, handledBy, actionLabel) => {
  const role = handledBy?.role;
  if (role && !isManagerRole(role)) {
    resp(res, 403, false, `Only admin or super admin can ${actionLabel}.`);
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Generate Job Number
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. CREATE JOB
// POST /api/jobs
// ─────────────────────────────────────────────────────────────────────────────
exports.createJob = async (req, res) => {
  try {
    const {
      customer_name, customer_phone, company_name, order_no, order_date,
      estimated_delivery_date, cart_items, delivery_address, job_status,
      subtotal, discount_percentage, discount_amount, taxable_amount,
      tax_amount, delivery_charges, free_delivery, total_amount, gst_no,
      payments, design_charges,
      valid_until, notes, terms_and_conditions, created_by,
      created_by_admin_id, site_visit_id, site_visit_no, site_visit_photos,
      material_needed, delivery_mode,
    } = req.body;

    const user = req.user || {};
    const creatorId   = user._id || user.user_id || created_by_admin_id || null;
    const creatorName = user.name || created_by || "Admin";
    const creatorRole = user.role || "admin";

    const job_no = await generateJobNo();

    const processedItems = (cart_items || []).map((item) => ({
      ...item,
      item_id: item.item_id || new mongoose.Types.ObjectId().toHexString(),
      production_type: item.production_type || item.printing_type || "",
      other_process_type: item.other_process_type || "",
      design_files: item.design_files || [],
      design_status: item.design_status || "pending",
      designers: item.designers || [],
    }));

    const now = new Date();

    // Build the job WITHOUT payments first. total_amount must be set
    // before we call addPayment(), since it validates amount against
    // the outstanding balance (total_amount - prior payments).
    const job = new Job({
      job_no,
      order_no: order_no || "",
      customer_name: customer_name || "",
      customer_phone: customer_phone || "",
      company_name: company_name || "",
      order_date: order_date ? new Date(order_date) : now,
      estimated_delivery_date: estimated_delivery_date ? new Date(estimated_delivery_date) : null,
      cart_items: processedItems,
      delivery_address: delivery_address || {},
      job_status: job_status || "pending_approval",
      job_approval_status: "pending",
      material_needed: material_needed !== undefined ? Boolean(material_needed) : true,
      delivery_mode: delivery_mode || "",
      status_updated_at: now,
      subtotal: parseFloat(subtotal) || 0,
      discount_percentage: parseFloat(discount_percentage) || 0,
      discount_amount: parseFloat(discount_amount) || 0,
      taxable_amount: parseFloat(taxable_amount) || 0,
      tax_amount: parseFloat(tax_amount) || 0,
      delivery_charges: parseFloat(delivery_charges) || 0,
      free_delivery: free_delivery ?? false,
      total_amount: parseFloat(total_amount),
      gst_no: gst_no || "",
      design_charges: parseFloat(design_charges) || 0,
      valid_until: valid_until ? new Date(valid_until) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      notes: notes || "",
      terms_and_conditions: terms_and_conditions || "",
      created_by: creatorName,
      created_by_admin_id: creatorId,
      qc_assignee: {
        user_id: creatorId,
        name: creatorName,
        role: creatorRole,
      },
      delivery_mode_set_by: {
        user_id: creatorId,
        name: creatorName,
        role: creatorRole,
      },
      workflow_stages: [
        {
          stage: "job_created",
          stage_label: "Job Created",
          handled_by: { user_id: creatorId, name: creatorName, role: creatorRole },
          assigned_by: { user_id: creatorId, name: creatorName },
          action: "pending_approval",
          assigned_at: now,
          notes: "Job created and pending approval by authorized staff.",
        },
      ],
      current_stage: {
        stage: "job_approval",
        stage_label: "Pending Approval",
        stage_action: "pending",
        assigned_to: { user_id: creatorId, name: creatorName, role: creatorRole },
        since: now,
      },
      converted_to_order: false,
      deletedAt: null,
      site_visit_id: site_visit_id || null,
      site_visit_no: site_visit_no || "",
      site_visit_photos: site_visit_photos || [],
    });

    const collectedBy = {
      user_id: creatorId,
      name:    creatorName,
    };

    for (const p of payments || []) {
      if (!p || !p.amount) continue;
      job.addPayment({
        amount:        p.amount,
        method:        p.method || "",
        notes:         p.notes || "",
        next_due_date: p.next_due_date || null,
        paid_at:       p.paid_at || null,
        collected_by:  collectedBy,
      });
    }

    await job.save();

    return res.status(201).json({
      success: true,
      message: "Job created successfully.",
      data: toPlain(job),
    });
  } catch (err) {
    console.error("❌ createJob", err);
    if (err.code === 11000 && err.keyPattern?.job_no)
      return resp(res, 409, false, "Job number conflict, please retry.");
    return resp(res, 500, false, err.message);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// 2. GET ALL JOBS
// GET /api/jobs
// ─────────────────────────────────────────────────────────────────────────────
exports.getAllJobs = async (req, res) => {
  try {
    const {
      status, stage, customer_name, job_no,
      page = 1, limit = 20,
      sort_by = "createdAt", sort_order = "desc",
      designer_user_id,
    } = req.query;

    const filter = {};
    if (status) filter.job_status = status;
    if (stage) filter["current_stage.stage"] = stage;
    if (customer_name) filter.customer_name = new RegExp(customer_name, "i");
    if (job_no) filter.job_no = new RegExp(job_no, "i");
    if (designer_user_id) {
      filter["cart_items.designers.user_id"] = new mongoose.Types.ObjectId(designer_user_id);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total = await Job.countDocuments(filter);
    const jobs = await Job.find(filter)
      .sort(sort)
      .skip(skip)
      .select("-workflow_stages")
      .lean();

    return resp(res, 200, true, "Jobs fetched successfully.", {
      jobs,
      pagination: {
        total,
        page: parseInt(page),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("❌ getAllJobs", err);
    return resp(res, 500, false, err.message);
  }
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


// ─────────────────────────────────────────────────────────────────────────────
// 3. GET SINGLE JOB
// GET /api/jobs/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getJobById = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate("workflow_stages.handled_by.user_id", "name role email")
      .populate("workflow_stages.assigned_by.user_id", "name role")
      .populate("workflow_stages.work_sessions.user_id", "name role email")
      .populate("current_stage.assigned_to.user_id", "name role email")
      .populate("cart_items.designers.user_id", "name role email")
      .populate("cart_items.design_files.assigned_to.user_id", "name role email")
      .lean();

    if (!job) return resp(res, 404, false, "Job not found.");
    return resp(res, 200, true, "Job fetched successfully.", job);
  } catch (err) {
    console.error("❌ getJobById", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. ADD DESIGN FILES TO A CART ITEM
// POST /api/jobs/:id/items/:itemId/design-files
// Body: { files: [{ url, file_name, file_type, label, caption, assigned_to? }], handled_by }
//
// ✅ Any normal designer can call this — uploading is always allowed. They
// simply won't (per the frontend) send a label/assigned_to, which is fine —
// both default sensibly below.
//
// ✅ FIX: previously, re-uploading a NEW file against an item that was
// already "approved" left design_status stuck on "approved", so the
// Approve/Reject controls in the UI stayed hidden/disabled for admins.
// Now ANY new file added moves the item back to "uploaded" — i.e. back into
// the review queue — regardless of whether it was previously pending,
// rejected, or approved. This is what makes "approve button reappears after
// a new design is uploaded post-approval" work.
// ─────────────────────────────────────────────────────────────────────────────
exports.addItemDesignFiles = async (req, res) => {
  try {
    const { id: jobId, itemId } = req.params;
    const { files, handled_by = {} } = req.body;

    if (!Array.isArray(files) || !files.length)
      return resp(res, 400, false, "files array is required.");

    const validFiles = files.filter((f) => f?.url?.trim());
    if (!validFiles.length)
      return resp(res, 400, false, "Each file must have a url.");

    // Full Mongoose doc — NOT lean — so pre-save hooks fire on .save()
    const job = await Job.findById(jobId);
    if (!job) return resp(res, 404, false, "Job not found.");

    // Resolve cart item — itemId may be item_id (string) OR _id (hex)
    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;

    if (!item) return resp(res, 404, false, "Cart item not found.");

    const now = new Date();
    const wasApproved = item.design_status === "approved";

    for (const f of validFiles) {
      const hasAssignee = !!f.assigned_to?.user_id || (f.assigned_to?.role === "outsource");
      item.design_files.push({
        url:         f.url.trim(),
        file_name:   (f.file_name  || "").trim(),
        file_type:   (f.file_type  || "").trim(),
        label:       (f.label      || "Other").trim(),
        caption:     (f.caption    || "").trim(),
        uploaded_at: now,
        uploaded_by: {
          user_id: handled_by.user_id || null,
          name:    handled_by.name    || "",
        },
        assigned_to: hasAssignee
          ? {
              user_id: f.assigned_to.user_id || null,
              name:    f.assigned_to.name || "",
              role:    f.assigned_to.role || "designing team",
            }
          : null,
        work_status: hasAssignee ? "assigned" : "pending",
        work_notes:  "",
      });
    }

    // ✅ Any new upload puts the item back in front of admin/superadmin for
    // review — including the case where it was already approved before.
    item.design_status = "uploaded";
    item.design_rejection_reason = "";
    if (wasApproved) {
      item.design_approved_at = null;
      item.design_approved_by = {};
    }

    // .save() fires ALL pre-save hooks (status rollup, timer recompute, etc.)
    await job.save();

    // Return plain object — frontend needs a clean serializable job
    return resp(res, 200, true, `${validFiles.length} design file(s) added.${wasApproved ? " Item is back in review." : ""}`, {
      job: toPlain(job),
    });
  } catch (err) {
    console.error("❌ addItemDesignFiles:", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. REMOVE A DESIGN FILE
// DELETE /api/jobs/:id/items/:itemId/design-files/:fileId
// ─────────────────────────────────────────────────────────────────────────────
exports.removeItemDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { force } = req.query;

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;
    if (!item) return resp(res, 404, false, "Cart item not found.");

    // BUG FIX: this used to delete the design file unconditionally, with no
    // check for whether material had already been issued (or outsourced)
    // against it. That silently orphaned the MaterialIssue record — it kept
    // existing in the database with all its real production/outsource
    // history, but since nothing matches design_file_id to a design file
    // that no longer exists, it became invisible everywhere in the UI
    // (Production Panel, Pickup Dashboard summaries, etc.) and the job
    // looked like it had never had material issued at all, even for
    // items that were already fully produced or delivered by a vendor.
    const linkedIssue = await MaterialIssue.findOne({
      job_id: id,
      design_file_id: fileId,
      is_deleted: false,
    }).lean();

    if (linkedIssue && force !== "true") {
      return resp(
        res,
        409,
        false,
        `Can't delete this file — material was already issued against it ` +
        `(${linkedIssue.issue_no}${linkedIssue.calc_mode === "outsource" ? ", outsourced" : ""}, ` +
        `status: ${linkedIssue.pickup_assignment?.status || linkedIssue.status}). ` +
        `Return/cancel that material issue first, or pass ?force=true to delete anyway ` +
        `and keep the history as an orphaned record.`,
      );
    }

    const before = item.design_files.length;
    item.design_files = item.design_files.filter(
      (f) => f._id.toString() !== fileId,
    );
    if (item.design_files.length === before)
      return resp(res, 404, false, "Design file not found.");

    if (!item.design_files.length && item.design_status === "uploaded")
      item.design_status = "pending";

    await job.save();

    return resp(res, 200, true, "Design file removed.", { job: toPlain(job) });
  } catch (err) {
    console.error("❌ removeItemDesignFile", err);
    return resp(res, 500, false, err.message);
  }
};


exports.approveJob = async (req, res) => {
  try {
    const { approved_by, approved_by_admin_id, assign_to, job_status, is_customer_designed } = req.body;

    if (!approved_by || !approved_by_admin_id)
      return resp(res, 400, false, "Approver name and ID are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.approved_by          = approved_by;
    job.approved_by_admin_id = approved_by_admin_id;
    job.job_approval_status  = "approved";
    job.status_updated_at    = now;

    // ── Branch: Customer-designed vs. Internal designer ───────────────────
    if (is_customer_designed) {
      job.job_status = job_status || "design";

      job.workflow_stages.push({
        stage:       "design",
        stage_label: "Design",
        handled_by:  { user_id: null, name: "Customer", role: "customer" },
        assigned_by: { user_id: approved_by_admin_id, name: approved_by },
        action:      "uploaded",          // ← key: marks as already uploaded
        assigned_at: now,
        started_at:  now,
        completed_at: now,               // design is effectively done
        work_sessions: [],
        notes: "Design provided by customer — no internal designer assigned.",
      });

      job.current_stage = {
        stage:        "design",
        stage_label:  "Design",
        stage_action: "uploaded",
        assigned_to:  { user_id: null, name: "Customer", role: "customer" },
        since:        now,
      };

      // Also update job-level design flags
      job.design_status    = "uploaded";
      job.design_is_sample = false;

    } else {
      // ── Internal designer path ──────────────────────────────────────────
      if (!assign_to?.user_id)
        return resp(res, 400, false, "A designer must be assigned when approving.");

      const designer = await AdminUsers.findById(assign_to.user_id);
      if (!designer || designer.role !== "designing team")
        return resp(res, 400, false, "Selected user is not a valid designer.");

      job.job_status = job_status || "design";

      job.workflow_stages.push({
        stage:       "design",
        stage_label: "Design",
        handled_by:  { user_id: designer._id, name: designer.name, role: designer.role },
        assigned_by: { user_id: approved_by_admin_id, name: approved_by },
        action:      "assigned",
        assigned_at: now,
        work_sessions: [],
        notes: "Job approved and assigned by admin.",
      });

      job.current_stage = {
        stage:        "design",
        stage_label:  "Design",
        stage_action: "assigned",
        assigned_to:  { user_id: designer._id, name: designer.name, role: designer.role },
        since:        now,
      };
    }

    await job.save();

    const msg = is_customer_designed
      ? "Job approved — customer-provided design marked as uploaded."
      : `Job approved and assigned to ${assign_to?.name || "designer"}.`;

    return resp(res, 200, true, msg, job);

  } catch (err) {
    console.error("approveJob ❌", err);
    return resp(res, 500, false, err.message);
  }
};


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
// QUALITY CHECK
// Used by both the dedicated Quality Check dashboard and the Super Admin
// Job Management panel — both send the same request shape.
// ─────────────────────────────────────────────────────────────────────────────

// POST /:id/qc/update
// Body: { qc_notes?, qc_images? (new photo URLs to append), handled_by? }
// Saves inspection notes/photos without changing pass/fail status.
exports.updateQC = async (req, res) => {
  try {
    const { qc_notes, qc_images, handled_by } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    if (Array.isArray(qc_images) && qc_images.length) {
      job.qc_images = [...(job.qc_images || []), ...qc_images];
    }
    if (typeof qc_notes === "string") {
      job.qc_notes = qc_notes;
    }
    if (handled_by?.name) {
      job.qc_inspected_by = handled_by.name;
      job.qc_inspected_at = new Date();
    }

    await job.save();
    return resp(res, 200, true, "QC data saved.", toPlain(job));
  } catch (err) {
    console.error("updateQC ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// POST /:id/qc/pass
// Body: { handled_by?: { user_id, name }, notes? }
// Marking QC as passed also moves the job forward to the "delivery" stage —
// this happens atomically here so it can't be skipped or left inconsistent
// by a caller that forgets the separate status-update call.
exports.passQC = async (req, res) => {
  try {
    const { handled_by, notes } = req.body;
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.qc_status           = "passed";
    job.qc_approved_at      = now;
    job.qc_approved_by      = handled_by?.user_id || job.qc_approved_by;
    job.qc_inspected_by     = handled_by?.name || job.qc_inspected_by;
    job.qc_inspected_at     = now;
    job.qc_rejection_reason = "";
    if (typeof notes === "string" && notes) job.qc_notes = notes;

    // ✅ QC passed → job moves on to Delivery.
    job.job_status = "delivery";

    await job.save();
    return resp(res, 200, true, "QC passed — job moved to Delivery.", toPlain(job));
  } catch (err) {
    console.error("passQC ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// POST /:id/qc/fail
// Body: { handled_by?: { user_id, name }, reason (required), notes? }
exports.failQC = async (req, res) => {
  try {
    const { handled_by, reason, notes } = req.body;
    if (!reason) return resp(res, 400, false, "Rejection reason is required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.qc_status           = "failed";
    job.qc_rejection_reason = reason;
    job.qc_inspected_by     = handled_by?.name || job.qc_inspected_by;
    job.qc_inspected_at     = now;
    if (typeof notes === "string" && notes) job.qc_notes = notes;

    await job.save();
    return resp(res, 200, true, "QC failed — rejection recorded.", toPlain(job));
  } catch (err) {
    console.error("failQC ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. ASSIGN FILE TO DESIGNER (initial assignment)
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/assign
// Body: { assigned_to: { user_id?, name, role? }, handled_by?: { user_id, name, role } }
//
// ✅ Admin/superadmin only (enforced if caller sends handled_by.role).
// Can also be called again later to change the assignee — see the dedicated
// `reassignDesignFile` below for the explicit "this file is already assigned,
// route it elsewhere (including Outsource)" flow, which behaves the same
// but is intended for that specific re-routing action and tracks who did it.
// ─────────────────────────────────────────────────────────────────────────────
exports.assignDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { assigned_to, handled_by = {} } = req.body;

    if (!requireManagerRole(res, handled_by, "assign design files")) return;

    if (!assigned_to?.name)
      return resp(res, 400, false, "assigned_to.name is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;
    if (!item) return resp(res, 404, false, "Cart item not found.");

    const file = item.design_files.find((f) => f._id.toString() === fileId);
    if (!file) return resp(res, 404, false, "Design file not found.");

    file.assigned_to = {
      user_id: assigned_to.user_id || null,
      name: assigned_to.name,
      role: assigned_to.role || "designing team",
    };
    file.work_status = "assigned";

    await job.save();

    return resp(res, 200, true, `File assigned to ${assigned_to.name}.`, {
      job: toPlain(job),
    });
  } catch (err) {
    console.error("❌ assignDesignFile", err);
    return resp(res, 500, false, err.message);
  }
};


const ok  = (res, data = {}, status = 200) =>
  res.status(status).json({ success: true,  ...data });

const err = (res, message = "Something went wrong", status = 500) =>
  res.status(status).json({ success: false, message });

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

exports.migrateDesignFile = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    if (!isValidId(id)) return err(res, "Invalid job ID", 400);

    const job = await Job.findById(id);
    if (!job) return err(res, "Job not found", 404);

    const item = job.findCartItem(itemId);
    if (!item) return err(res, `Cart item "${itemId}" not found`, 404);

    // Nothing to migrate
    if (!item.design_file) {
      // If already migrated (file is in array, design_file is empty), return ok
      // so the frontend can safely call migrate idempotently.
      return ok(res, {
        message: "No legacy file to migrate",
        data: { job, migrated_file_id: null },
      });
    }

    const { label = "Other", assigned_to, handled_by = {} } = req.body;

    const legacyUrl = item.design_file;

    // Derive a reasonable file_name and file_type from the URL
    const urlPath    = legacyUrl.split("?")[0]; // strip query params
    const fileName   = urlPath.split("/").pop() || "design_file";
    const fileExt    = fileName.split(".").pop()?.toLowerCase() || "";

    // Build the new design_files entry
    const newFileData = {
      url:       legacyUrl,
      file_name: fileName,
      file_type: fileExt,
      label,
      caption:   "Migrated from legacy design_file",
      uploaded_at: new Date(),
      uploaded_by: {
        user_id: handled_by.user_id || null,
        name:    handled_by.name    || "System",
      },
    };

    if (assigned_to) {
      newFileData.assigned_to = {
        user_id: assigned_to.user_id || null,
        name:    assigned_to.name    || "",
        role:    assigned_to.role    || "",
      };
    }

    item.design_files.push(newFileData);

    // The newly pushed document — get its _id before clearing design_file
    const migratedFile = item.design_files[item.design_files.length - 1];
    const migratedFileId = migratedFile._id.toString();

    // Clear the legacy field so it won't appear in the UI again
    item.design_file = "";

    // Ensure design_status reflects that we now have a file in the array
    if (item.design_status === "pending") {
      item.design_status = "uploaded";
    }

    await job.save();

    ok(res, {
      message: "Legacy design file migrated successfully",
      data: {
        job,
        migrated_file_id: migratedFileId,
      },
    });
  } catch (e) {
    err(res, e.message);
  }
};
 
// ─────────────────────────────────────────────────────────────────────────────
// 6b. REASSIGN FILE TO A DIFFERENT DESIGNER / OUTSOURCE  (NEW)
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/reassign
// Body: { assigned_to: { user_id?, name, role? }, handled_by?: { user_id, name, role } }
//
// ✅ New, additive endpoint — does not replace `assignDesignFile` above.
// Lets admin/superadmin move a file that's already in someone's queue to a
// different internal designer, or hand it off to "Outsource"
// ({ name: "Outsource", role: "outsource" }), at any point after the
// original assignment. Same effect as calling /assign again, but kept as
// its own endpoint so re-routing actions are explicit and easy to find/audit.
// ─────────────────────────────────────────────────────────────────────────────
exports.reassignDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    if (!isValidId(id)) return err(res, "Invalid job ID", 400);
 
    const { assigned_to, label, handled_by } = req.body;
    if (!assigned_to) return err(res, "assigned_to is required", 400);
 
    const job = await Job.findById(id);
    if (!job) return err(res, "Job not found", 404);
 
    const item = job.findCartItem(itemId);
    if (!item) return err(res, `Cart item "${itemId}" not found`, 404);
 
    const file = item.design_files.id(fileId);
    if (!file) return err(res, `Design file "${fileId}" not found`, 404);
 
    // Update assignment
    file.assigned_to = {
      user_id: assigned_to.user_id || null,
      name:    assigned_to.name    || "",
      role:    assigned_to.role    || "",
    };
 
    // Optionally update label
    if (label) file.label = label;
 
    await job.save();
    ok(res, { message: "File reassigned successfully", data: { job } });
  } catch (e) {
    err(res, e.message);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// 7. UPDATE FILE WORK STATUS
// PATCH /api/jobs/:id/items/:itemId/design-files/:fileId/status
// ─────────────────────────────────────────────────────────────────────────────
exports.updateFileWorkStatus = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { work_status, work_notes = "" } = req.body;

    const allowed = ["pending", "assigned", "in_progress", "completed", "approved", "rejected"];
    if (!work_status || !allowed.includes(work_status))
      return resp(res, 400, false, `work_status must be one of: ${allowed.join(", ")}`);

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;
    if (!item) return resp(res, 404, false, "Cart item not found.");

    const file = item.design_files.find((f) => f._id.toString() === fileId);
    if (!file) return resp(res, 404, false, "Design file not found.");

    file.work_status = work_status;
    if (work_notes) file.work_notes = work_notes;

    await job.save();

    return resp(res, 200, true, `File work status updated to "${work_status}".`, {
      job: toPlain(job),
    });
  } catch (err) {
    console.error("❌ updateFileWorkStatus", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. APPROVE ITEM DESIGN
// POST /api/jobs/:id/items/:itemId/approve-design
// ✅ Admin/superadmin only (enforced if caller sends handled_by.role).
// ─────────────────────────────────────────────────────────────────────────────
exports.approveItemDesign = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { handled_by = {} } = req.body;

    if (!requireManagerRole(res, handled_by, "approve item designs")) return;

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;
    if (!item) return resp(res, 404, false, "Cart item not found.");

    item.design_status = "approved";
    item.design_approved_at = new Date();
    item.design_approved_by = {
      user_id: handled_by.user_id || null,
      name: handled_by.name || "",
    };
    item.design_rejection_reason = "";

    await job.save();

    const allApproved = job.cart_items.every((i) => i.design_status === "approved");

    return resp(
      res, 200, true,
      allApproved ? "All items approved!" : "Item design approved.",
      { job: toPlain(job) },
    );
  } catch (err) {
    console.error("❌ approveItemDesign", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. REJECT ITEM DESIGN
// POST /api/jobs/:id/items/:itemId/reject-design
// ✅ Admin/superadmin only (enforced if caller sends handled_by.role).
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectItemDesign = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { handled_by = {}, notes = "" } = req.body;

    if (!requireManagerRole(res, handled_by, "reject item designs")) return;

    if (!notes?.trim())
      return resp(res, 400, false, "Rejection reason is required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item =
      job.cart_items.find((i) => i.item_id === itemId) ||
      job.cart_items.find((i) => i._id.toString() === itemId) ||
      null;
    if (!item) return resp(res, 404, false, "Cart item not found.");

    item.design_status = "rejected";
    item.design_rejection_reason = notes;
    item.design_approved_at = null;
    item.design_approved_by = {};

    await job.save();

    return resp(res, 200, true, "Item design rejected.", { job: toPlain(job) });
  } catch (err) {
    console.error("❌ rejectItemDesign", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET DESIGN SUMMARY
// GET /api/jobs/:id/design-summary
// ─────────────────────────────────────────────────────────────────────────────
exports.getDesignSummary = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select("job_no job_status design_status design_drive_link cart_items")
      .populate("cart_items.design_files.assigned_to.user_id", "name role email")
      .lean();

    if (!job) return resp(res, 404, false, "Job not found.");

    const items = (job.cart_items || []).map((item) => {
      const files = item.design_files || [];
      const approved  = files.filter((f) => f.work_status === "approved").length;
      const rejected  = files.filter((f) => f.work_status === "rejected").length;
      const inProg    = files.filter((f) => ["assigned", "in_progress", "completed"].includes(f.work_status)).length;

      return {
        item_id:                 item.item_id,
        product_name:            item.product_name,
        variation:               item.variation,
        size:                    item.size,
        quantity:                item.quantity,
        quantity_type:           item.quantity_type,
        design_status:           item.design_status || "pending",
        design_rejection_reason: item.design_rejection_reason || "",
        design_approved_at:      item.design_approved_at,
        files_summary: {
          total:       files.length,
          approved,
          rejected,
          in_progress: inProg,
          pending:     files.length - approved - rejected - inProg,
        },
        design_files: files,
        designers:    item.designers || [],
      };
    });

    const total    = items.length;
    const approved = items.filter((i) => i.design_status === "approved").length;
    const rejected = items.filter((i) => i.design_status === "rejected").length;
    const pending  = items.filter((i) => i.design_status === "pending").length;
    const partial  = total - approved - rejected - pending;

    return resp(res, 200, true, "Design summary fetched.", {
      job_no:            job.job_no,
      job_design_status: job.design_status,
      design_drive_link: job.design_drive_link,
      summary:           { total, approved, partial, rejected, pending },
      items,
    });
  } catch (err) {
    console.error("❌ getDesignSummary", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 11. UPLOAD DESIGN (Legacy job-level / drive link)
// POST /api/jobs/:id/upload_design
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadDesign = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const {
      notes = "",
      duration_seconds = 0,
      duration_display = "00:00:00",
      design_file = "",
      design_drive_link = "",
      stage = job.current_stage?.stage || "design",
      handled_by = {},
      is_sample = false,
    } = req.body;

    const handledByObj = typeof handled_by === "string" ? JSON.parse(handled_by) : handled_by;

    if (!design_file && !design_drive_link)
      return resp(res, 400, false, "A design file path or Drive link is required.");

    if (design_file)       job.design_file       = design_file;
    if (design_drive_link) job.design_drive_link = design_drive_link;

    job.design_uploaded_at      = new Date();
    job.design_uploaded_by      = handledByObj.name || "";
    job.design_duration_seconds = parseInt(duration_seconds, 10) || 0;
    job.design_duration_display = duration_display;
    job.design_is_sample        = is_sample === true || is_sample === "true";

    const hasItemDesigns = job.cart_items.some((i) => i.design_files?.length > 0);
    if (!hasItemDesigns) job.design_status = "uploaded";

    if (job.hasOpenSession(stage))
      job.closeSession({ stageName: stage, action: "completed", notes });

    await job.save();

    // Return full job so frontend can sync all state from one response
    return resp(res, 200, true, "Design uploaded.", { job: toPlain(job) });
  } catch (err) {
    console.error("❌ uploadDesign", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. UPDATE JOB
// PUT /api/jobs/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.updateJob = async (req, res) => {
  try {
    const allowedFields = [
      "customer_name", "customer_phone", "company_name", "cart_items",
      "delivery_address", "estimated_delivery_date", "order_date",
      "subtotal", "discount_percentage", "discount_amount", "taxable_amount",
      "tax_amount", "delivery_charges", "free_delivery", "total_amount",
      "rounding_adjustment", "design_charges",
      "gst_no", "valid_until", "notes", "terms_and_conditions",
    ];

    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (!Object.keys(updates).length)
      return resp(res, 400, false, "No valid fields provided to update.");

    // Use a full document load so the pre-save hook (recomputePayments)
    // fires correctly when total_amount changes.
    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");

    Object.assign(job, updates);
    // Explicitly trigger recompute in case total_amount changed but
    // the hook hasn't detected it as modified yet.
    if (updates.total_amount !== undefined) {
      job.recomputePayments();
    }

    await job.save();

    return resp(res, 200, true, "Job updated successfully.", job.toObject());
  } catch (err) {
    console.error("❌ updateJob", err);
    return resp(res, 500, false, err.message);
  }
};
// ─────────────────────────────────────────────────────────────────────────────
// 13. UPDATE JOB STATUS
// PATCH /api/jobs/:id/status
// ─────────────────────────────────────────────────────────────────────────────
exports.updateJobStatus = async (req, res) => {
  try {
    const { job_status, productionimg } = req.body;
    if (!job_status) return resp(res, 400, false, "job_status is required.");

    const setFields = { job_status, status_updated_at: new Date() };

    // BUG FIX: `productionimg` is declared on the Job schema and displayed
    // on Myjobs.jsx / Dashboard.jsx under "Production Image" — but nothing
    // in the app ever wrote to it. The Production Upload Panel only ever
    // saved photos onto each *material issue* (per design file), never
    // back onto the Job document itself, so this section never rendered
    // for any job. Let callers optionally pass a representative photo URL
    // here (the production panel does this when submitting to QC) so it
    // actually gets persisted.
    if (typeof productionimg === "string" && productionimg.trim()) {
      setFields.productionimg          = productionimg.trim();
      setFields.production_status      = "completed";
      setFields.production_approved_at = new Date();
    }

    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { $set: setFields },
      { new: true },
    ).lean();

    if (!job) return resp(res, 404, false, "Job not found.");

    return resp(res, 200, true, `Job status updated to "${job_status}".`, job);
  } catch (err) {
    console.error("❌ updateJobStatus", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 14. SESSION MANAGEMENT
// POST /api/jobs/:id/session/open
// POST /api/jobs/:id/session/close
// GET  /api/jobs/:id/session/status
// ─────────────────────────────────────────────────────────────────────────────
exports.openSession = async (req, res) => {
  try {
    const { stage, stage_label, user, notes } = req.body;
    if (!stage) return resp(res, 400, false, "stage is required.");
    if (!user?.user_id || !user?.name)
      return resp(res, 400, false, "user.user_id and user.name are required.");

    const job = await Job.findById(req.params.id);
    if (!job) return resp(res, 404, false, "Job not found.");
    if (job.hasOpenSession(stage))
      return resp(res, 409, false, `A session for stage "${stage}" is already open.`);

    job.openSession({ stageName: stage, stageLabel: stage_label, user, notes });
    await job.save();

    return resp(res, 200, true, `Session opened for stage "${stage}".`, {
      job_no:        job.job_no,
      stage_summary: job.getSessionSummary(stage),
    });
  } catch (err) {
    console.error("❌ openSession", err);
    return resp(res, 500, false, err.message);
  }
};

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

    return resp(res, 200, true, msgs[action] || `Session closed with action "${action}".`, {
      job_no:        job.job_no,
      stage_summary: summary,
    });
  } catch (err) {
    console.error("❌ closeSession", err);
    return resp(res, 500, false, err.message);
  }
};

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
      if (!stageEntry)
        return resp(res, 200, true, "Session status fetched.", {
          job_no: job.job_no, stage, has_open_session: false, total_sessions: 0,
        });

      const sessions   = Array.isArray(stageEntry.work_sessions) ? stageEntry.work_sessions : [];
      const openSession = sessions.find((s) => !s.session_end);

      return resp(res, 200, true, "Session status fetched.", {
        job_no:                 job.job_no,
        stage,
        stage_action:           stageEntry.action,
        has_open_session:       !!openSession,
        open_since:             openSession?.session_start || null,
        total_sessions:         sessions.length,
        total_duration_seconds: stageEntry.total_duration_seconds || 0,
        total_duration_display: stageEntry.total_duration_display || "00:00:00",
        worked_days:            stageEntry.worked_days || 0,
        daily_summary:          stageEntry.daily_summary || [],
        closed_sessions:        sessions.filter((s) => s.session_end).length,
      });
    }

    const stageSummaries = workflowStages.map((s) => {
      const sessions = Array.isArray(s.work_sessions) ? s.work_sessions : [];
      return {
        stage:                  s.stage,
        action:                 s.action,
        has_open_session:       sessions.some((x) => !x.session_end),
        total_duration_display: s.total_duration_display || "00:00:00",
      };
    });

    return resp(res, 200, true, "All stage session statuses fetched.", {
      job_no:        job.job_no,
      current_stage: job.current_stage,
      stages:        stageSummaries,
    });
  } catch (err) {
    console.error("❌ getSessionStatus", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 15. DELETE / RESTORE
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
    return resp(res, 200, true, "Job soft-deleted.");
  } catch (err) {
    console.error("❌ deleteJob", err);
    return resp(res, 500, false, err.message);
  }
};

exports.restoreJob = async (req, res) => {
  try {
    const job = await Job.findById(req.params.id).includeDeleted();
    if (!job) return resp(res, 404, false, "Job not found.");

    job.deletedAt     = null;
    job.deleted_notes = "";

    await job.save();
    return resp(res, 200, true, "Job restored.");
  } catch (err) {
    console.error("❌ restoreJob", err);
    return resp(res, 500, false, err.message);
  }
};

// Approve a single design file
// ✅ Admin/superadmin only (enforced if caller sends handled_by.role).
exports.approveDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { handled_by = {} } = req.body;

    if (!requireManagerRole(res, handled_by, "approve design files")) return;

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item = job.cart_items.find(i => i.item_id === itemId || i._id.toString() === itemId);
    if (!item) return resp(res, 404, false, "Cart item not found.");

    const file = item.design_files.find(f => f._id.toString() === fileId);
    if (!file) return resp(res, 404, false, "Design file not found.");

    file.work_status = "approved";
    file.approved_at = new Date();
    file.approved_by = {
      user_id: handled_by.user_id || null,
      name: handled_by.name || "",
    };

    await job.save();
    return resp(res, 200, true, "Design file approved.", { job: toPlain(job) });
  } catch (err) {
    console.error("❌ approveDesignFile", err);
    return resp(res, 500, false, err.message);
  }
};

// Reject a single design file
// ✅ Admin/superadmin only (enforced if caller sends handled_by.role).
exports.rejectDesignFile = async (req, res) => {
  try {
    const { id, itemId, fileId } = req.params;
    const { handled_by = {}, notes = "" } = req.body;

    if (!requireManagerRole(res, handled_by, "reject design files")) return;

    if (!notes?.trim()) return resp(res, 400, false, "Rejection reason required.");

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const item = job.cart_items.find(i => i.item_id === itemId || i._id.toString() === itemId);
    if (!item) return resp(res, 404, false, "Cart item not found.");

    const file = item.design_files.find(f => f._id.toString() === fileId);
    if (!file) return resp(res, 404, false, "Design file not found.");

    file.work_status = "rejected";
    file.rejection_reason = notes;
    file.rejected_at = new Date();
    file.rejected_by = {
      user_id: handled_by.user_id || null,
      name: handled_by.name || "",
    };

    await job.save();
    return resp(res, 200, true, "Design file rejected.", { job: toPlain(job) });
  } catch (err) {
    console.error("❌ rejectDesignFile", err);
    return resp(res, 500, false, err.message);
  }
};

// POST /api/jobs/:id/collect-payment
exports.collectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      amount,
      method       = "",
      notes        = "",
      next_due_date = null,
      discount_applied = 0,   // ← NEW: waiver/discount before collecting
    } = req.body;

    const job = await Job.findById(id);
    if (!job) return res.status(404).json({ success: false, message: "Job not found" });

    const profile = req.user || {};

    // Apply discount waiver first — reduces total_amount permanently
    const discountAmt = parseFloat(discount_applied) || 0;
    if (discountAmt > 0) {
      const currentBalance = parseFloat(job.balance_amount || 0);
      if (discountAmt > currentBalance + 0.01) {
        return res.status(400).json({
          success: false,
          message: `Discount (₹${discountAmt.toFixed(2)}) exceeds current balance (₹${currentBalance.toFixed(2)}).`,
        });
      }
      // Reduce the job total by the discount so balance shrinks accordingly
      job.total_amount = parseFloat((job.total_amount - discountAmt).toFixed(2));
      job.discount_amount = parseFloat(((job.discount_amount || 0) + discountAmt).toFixed(2));
      job.recomputePayments(); // recalculate balance after discount
    }

    // Now record the actual cash payment (if any)
    if (parseFloat(amount) > 0) {
      job.addPayment({
        amount,
        method,
        notes,
        next_due_date,
        collected_by: { user_id: profile._id || null, name: profile.name || "" },
      });
    }

    await job.save();

    return res.json({
      success: true,
      message: "Payment recorded successfully",
      data: job,
    });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || "Failed to record payment" });
  }
};
/**
 * ════════════════════════════════════════════════════════════════════════════
 * NEW METHODS FOR JOB CONTROLLER
 * Add these methods to the existing Job.controller.js file
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * These methods handle:
 * 1. Getting design files for production panel
 * 2. Getting delivery details for delivery panel
 * 3. Collecting payments during delivery
 */

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE HELPER (should already exist in your controller)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET DESIGN FILES FOR PRODUCTION PANEL
// GET /api/jobs/:jobId/design-files
// 
// Returns all design files grouped by cart item, formatted for the production
// staff to download and use for manufacturing.
// 
// Response format:
// {
//   success: true,
//   message: "Design files retrieved",
//   data: [
//     {
//       item_id: "...",
//       item_name: "...",
//       item_sku: "...",
//       item_category: "...",
//       design_files: [ { _id, url, file_name, label, caption, ... } ]
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
exports.getDesignFilesForProduction = async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await Job.findById(jobId)
      .select("job_no job_status cart_items")
      .lean();

    if (!job) {
      return resp(res, 404, false, "Job not found");
    }

    // Check if job is in production or later stage
    const productionStatuses = ["production", "qc", "ready", "delivered", "completed"];
    if (!productionStatuses.includes(job.job_status)) {
      return resp(res, 403, false, "Job must be in production stage to view design files");
    }

    // Format design files by item
    const designFilesGrouped = job.cart_items.map((item) => ({
      item_id: item._id?.toString() || item.item_id,
      item_name: item.item_name || "",
      item_sku: item.item_sku || "",
      item_category: item.item_category || "",
      quantity: item.quantity || 0,
      unit: item.unit || "",
      design_files: (item.design_files || []).map((file) => ({
        _id: file._id?.toString(),
        url: file.url,
        file_name: file.file_name,
        file_type: file.file_type,
        label: file.label,
        caption: file.caption,
        uploaded_at: file.uploaded_at,
        uploaded_by: {
          user_id: file.uploaded_by?.user_id?.toString() || "",
          name: file.uploaded_by?.name || "",
        },
        work_status: file.work_status || "pending",
        work_notes: file.work_notes || "",
        approved_at: file.approved_at || null,
        rejection_reason: file.rejection_reason || "",
      })),
    }));

    return resp(
      res,
      200,
      true,
      "Design files retrieved successfully",
      designFilesGrouped
    );
  } catch (error) {
    console.error("❌ getDesignFilesForProduction", error);
    return resp(res, 500, false, error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET DELIVERY DETAILS FOR DELIVERY PANEL
// GET /api/jobs/:jobId/delivery-details
// 
// Returns all delivery and payment information needed by delivery staff.
// Delivery details are READ-ONLY (set at job creation).
// Payments can be updated via collectPayment endpoint.
// 
// Response format:
// {
//   success: true,
//   message: "Delivery details retrieved",
//   data: {
//     job_no: "DM0001",
//     customer_name: "...",
//     customer_phone: "...",
//     delivery_address: { street, city, state, pincode, country },
//     estimated_delivery_date: "2024-01-20",
//     delivery_mode: "Home Delivery",
//     delivery_charges: 500,
//     free_delivery: false,
//     total_amount: 50000,
//     payment_amount: 30000,
//     balance_amount: 20000,
//     next_due_date: "2024-01-25",
//     payments: [ { _id, amount, method, paid_at, collected_by, notes } ]
//   }
// }
// ─────────────────────────────────────────────────────────────────────────────
exports.getDeliveryDetails = async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await Job.findById(jobId)
      .select(
        "job_no job_status customer_name customer_phone delivery_address " +
        "estimated_delivery_date delivery_mode delivery_payment_mode is_credit " +
        "credit_details delivery_assigned_to delivery_notes delivery_status " +
        "delivery_charges free_delivery total_amount payment_amount balance_amount " +
        "next_due_date payments receiver_name tracking_no delivery_photos"
      )
      .populate("payments.collected_by.user_id", "name role email")
      .populate("credit_details.approved_by.user_id", "name role")
      .populate("delivery_assigned_to.user_id", "name role")
      .lean();

    if (!job) {
      return resp(res, 404, false, "Job not found");
    }

    // Format delivery details response
    const data = {
      _id: job._id?.toString(),
      job_no: job.job_no,
      job_status: job.job_status,
      customer_name: job.customer_name,
      customer_phone: job.customer_phone,
      delivery_address: {
        street: job.delivery_address?.street || "",
        city: job.delivery_address?.city || "",
        state: job.delivery_address?.state || "",
        pincode: job.delivery_address?.pincode || "",
        country: job.delivery_address?.country || "India",
      },
      estimated_delivery_date: job.estimated_delivery_date,
      delivery_mode: job.delivery_mode || "Not Specified",
      delivery_payment_mode: job.delivery_payment_mode || (job.is_credit ? "Credit" : "Cash"),
      is_credit: !!job.is_credit,
      credit_details: job.credit_details || null,
      delivery_assigned_to: job.delivery_assigned_to || null,
      delivery_notes: job.delivery_notes || "",
      delivery_status: job.delivery_status || "pending",
      receiver_name: job.receiver_name || "",
      tracking_no: job.tracking_no || "",
      delivery_photos: job.delivery_photos || [],
      delivery_charges: job.delivery_charges || 0,
      free_delivery: job.free_delivery || false,
      total_amount: job.total_amount || 0,
      payment_amount: job.payment_amount || 0,
      balance_amount: job.balance_amount || 0,
      next_due_date: job.next_due_date || null,
      payments: (job.payments || []).map((payment) => ({
        _id: payment._id?.toString(),
        amount: payment.amount,
        method: payment.method,
        paid_at: payment.paid_at,
        balance_after: payment.balance_after || 0,
        collected_by: {
          user_id: payment.collected_by?.user_id?.toString() || "",
          name: payment.collected_by?.name || "",
        },
        notes: payment.notes || "",
      })),
    };

    return resp(
      res,
      200,
      true,
      "Delivery details retrieved successfully",
      data
    );
  } catch (error) {
    console.error("❌ getDeliveryDetails", error);
    return resp(res, 500, false, error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. COLLECT PAYMENT DURING DELIVERY
// POST /api/jobs/:jobId/collect-payment
// ─────────────────────────────────────────────────────────────────────────────
exports.collectPaymentDelivery = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { amount, method, notes = "", delivery_notes = "" } = req.body;

    // Get user info from request (should be attached by auth middleware)
    const userId = req.user?.user_id || req.user?._id || null;
    const userName = req.user?.name || "Unknown";
    const userRole = req.user?.role || "";

    // ─── VALIDATION ───────────────────────────────────────────────────────────
    if (!amount || typeof amount !== "number") {
      return resp(res, 400, false, "Amount must be a valid number");
    }

    if (amount <= 0) {
      return resp(res, 400, false, "Amount must be greater than 0");
    }

    if (!method || typeof method !== "string") {
      return resp(res, 400, false, "Payment method is required");
    }

    // ─── FETCH JOB ─────────────────────────────────────────────────────────────
    const job = await Job.findById(jobId);

    if (!job) {
      return resp(res, 404, false, "Job not found");
    }

    // ─── VALIDATE AMOUNT ──────────────────────────────────────────────────────
    if (amount > job.balance_amount + 0.01) {
      return resp(
        res,
        400,
        false,
        `Payment amount ₹${amount} exceeds remaining balance ₹${job.balance_amount}`
      );
    }

    // ─── ADD PAYMENT ───────────────────────────────────────────────────────────
    if (typeof job.addPayment === "function") {
      job.addPayment({
        amount,
        method,
        notes,
        collected_by: {
          user_id: userId,
          name: userName,
        },
      });
    } else {
      const newPayment = {
        amount,
        method,
        paid_at: new Date(),
        notes,
        collected_by: {
          user_id: userId,
          name: userName,
        },
        balance_after: Math.max(0, job.balance_amount - amount),
      };

      if (!job.payments) job.payments = [];
      job.payments.push(newPayment);

      job.payment_amount = (job.payment_amount || 0) + amount;
      job.balance_amount = Math.max(0, (job.total_amount || 0) - job.payment_amount);
    }

    // ─── UPDATE DELIVERY NOTES ────────────────────────────────────────────────
    if (delivery_notes) {
      job.delivery_notes = (job.delivery_notes || "") + "\n" + delivery_notes;
    }

    // ─── SAVE JOB ──────────────────────────────────────────────────────────────
    await job.save();

    // ─── RESPONSE ──────────────────────────────────────────────────────────────
    const lastPayment = job.payments[job.payments.length - 1];

    return resp(res, 200, true, "Payment collected successfully", {
      payment_id: lastPayment._id?.toString(),
      payment_amount: amount,
      method: method,
      paid_at: lastPayment.paid_at,
      total_amount: job.total_amount,
      payment_amount_total: job.payment_amount,
      balance_amount: job.balance_amount,
      next_due_date: job.next_due_date || null,
      job_status: job.job_status,
      is_credit: job.is_credit,
    });
  } catch (error) {
    console.error("❌ collectPaymentDelivery", error);
    return resp(res, 500, false, error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. SET DELIVERY MODE (AFTER PRODUCTION & PAYMENT PROCESSING)
// POST /api/jobs/:id/set-delivery-mode
// ─────────────────────────────────────────────────────────────────────────────
exports.setDeliveryMode = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      delivery_mode,
      delivery_payment_mode = "Cash",
      is_credit = false,
      credit_notes = "",
      credit_due_date = null,
      payment = null,
      assigned_to = null,
      handled_by = {},
      notes = "",
    } = req.body;

    if (!delivery_mode) {
      return resp(res, 400, false, "Delivery mode is required.");
    }

    const job = await Job.findById(id);
    if (!job) {
      return resp(res, 404, false, "Job not found.");
    }

    const now = new Date();
    const adminUser = req.user || handled_by || {};

    // 1. Process payment if immediate collection provided
    if (payment && parseFloat(payment.amount) > 0) {
      const pAmt = parseFloat(payment.amount);
      job.addPayment({
        amount: pAmt,
        method: payment.method || delivery_payment_mode || "Cash",
        notes: payment.notes || "Collected at delivery mode setting",
        collected_by: {
          user_id: adminUser.user_id || adminUser._id || null,
          name: adminUser.name || "Staff",
        },
      });
    }

    // 2. Set Credit details if credit mode selected or requested
    const isCreditMode = is_credit === true || delivery_payment_mode === "Credit";
    if (isCreditMode) {
      job.is_credit = true;
      job.delivery_payment_mode = "Credit";
      job.credit_details = {
        approved_by: {
          user_id: adminUser.user_id || adminUser._id || null,
          name: adminUser.name || "Authorized Staff",
          role: adminUser.role || "admin",
        },
        approved_at: now,
        credit_amount: job.balance_amount || 0,
        due_date: credit_due_date ? new Date(credit_due_date) : null,
        notes: credit_notes || notes || "Credit approved for delivery without immediate payment.",
      };
      if (credit_due_date) {
        job.next_due_date = new Date(credit_due_date);
      }
    } else {
      job.is_credit = false;
      job.delivery_payment_mode = delivery_payment_mode;
    }

    // 3. Set Delivery Mode & Assignment
    job.delivery_mode = delivery_mode;
    if (assigned_to?.name) {
      job.delivery_assigned_to = {
        user_id: assigned_to.user_id || null,
        name: assigned_to.name || "",
        role: assigned_to.role || "delivery team",
      };
    }

    if (notes) {
      job.delivery_notes = (job.delivery_notes ? job.delivery_notes + "\n" : "") + notes;
    }

    job.delivery_status = "ready_for_delivery";
    job.job_status = "delivery";
    job.status_updated_at = now;

    // 4. Update workflow stages
    const stageEntry = {
      stage: "delivery",
      stage_label: `Delivery (${delivery_mode})`,
      handled_by: {
        user_id: assigned_to?.user_id || adminUser.user_id || adminUser._id || null,
        name: assigned_to?.name || adminUser.name || "Delivery Team",
        role: assigned_to?.role || "delivery team",
      },
      assigned_by: {
        user_id: adminUser.user_id || adminUser._id || null,
        name: adminUser.name || "Admin",
      },
      action: "assigned",
      assigned_at: now,
      started_at: null,
      completed_at: null,
      work_sessions: [],
      notes: notes || `Delivery mode set to "${delivery_mode}" with payment mode "${job.delivery_payment_mode}".`,
    };

    job.workflow_stages.push(stageEntry);
    job.current_stage = {
      stage: "delivery",
      stage_label: `Delivery (${delivery_mode})`,
      stage_action: "assigned",
      assigned_to: stageEntry.handled_by,
      since: now,
    };

    await job.save();

    return resp(res, 200, true, `Delivery mode set to "${delivery_mode}" successfully.`, toPlain(job));
  } catch (error) {
    console.error("❌ setDeliveryMode", error);
    return resp(res, 500, false, error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. GET PAYMENT HISTORY
// GET /api/jobs/:jobId/payment-history
// ─────────────────────────────────────────────────────────────────────────────
exports.getPaymentHistory = async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await Job.findById(jobId)
      .select(
        "job_no total_amount payment_amount balance_amount " +
        "next_due_date is_credit credit_details payments"
      )
      .populate("payments.collected_by.user_id", "name role email")
      .lean();

    if (!job) {
      return resp(res, 404, false, "Job not found");
    }

    const data = {
      job_no: job.job_no,
      total_amount: job.total_amount,
      payment_amount: job.payment_amount,
      balance_amount: job.balance_amount,
      next_due_date: job.next_due_date,
      is_credit: !!job.is_credit,
      credit_details: job.credit_details || null,
      payments: (job.payments || []).map((payment) => ({
        _id: payment._id?.toString(),
        amount: payment.amount,
        method: payment.method,
        paid_at: payment.paid_at,
        balance_after: payment.balance_after || 0,
        collected_by: {
          user_id: payment.collected_by?.user_id?.toString() || "",
          name: payment.collected_by?.name || "",
        },
        notes: payment.notes || "",
      })),
    };

    return resp(res, 200, true, "Payment history retrieved", data);
  } catch (error) {
    console.error("❌ getPaymentHistory", error);
    return resp(res, 500, false, error.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. SET MATERIAL NEEDED (STORE MANAGER WORKFLOW)
// PATCH /api/jobs/:id/material-needed
// ─────────────────────────────────────────────────────────────────────────────
exports.setMaterialNeeded = async (req, res) => {
  try {
    const { id } = req.params;
    const { material_needed = false, notes = "" } = req.body;
    const user = req.user || {};

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.material_needed = Boolean(material_needed);
    job.status_updated_at = now;

    if (!job.material_needed) {
      job.job_status = "production";
      job.workflow_stages.push({
        stage: "production",
        stage_label: "Production",
        handled_by: {
          user_id: user._id || user.user_id || null,
          name: user.name || "Store Manager",
          role: user.role || "store manager",
        },
        assigned_by: {
          user_id: user._id || user.user_id || null,
          name: user.name || "Store Manager",
        },
        action: "ready_for_production",
        assigned_at: now,
        notes: notes || "Material Needed set to OFF by Store Manager — forwarded to Production.",
      });
      job.current_stage = {
        stage: "production",
        stage_label: "Production (Direct)",
        stage_action: "ready_for_production",
        assigned_to: { user_id: null, name: "Production Floor", role: "production team" },
        since: now,
      };
    }

    await job.save();
    return resp(
      res,
      200,
      true,
      `Material requirement set to ${job.material_needed ? "ON" : "OFF"}.`,
      toPlain(job)
    );
  } catch (err) {
    console.error("setMaterialNeeded ❌", err);
    return resp(res, 500, false, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. COMPLETE FINAL DELIVERY & ARCHIVE JOB (DEDICATED PANEL)
// POST /api/jobs/:id/complete-delivery
// ─────────────────────────────────────────────────────────────────────────────
exports.completeJobDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      delivery_method,
      tracking_no = "",
      courier_name = "",
      receiver_name = "",
      receiver_phone = "",
      delivery_date = null,
      delivery_notes = "",
      payment_status = "",
      credit_amount = 0,
      photos = [],
    } = req.body;

    const user = req.user || {};
    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.final_delivery = {
      status: "completed",
      delivery_method: delivery_method || job.delivery_mode || "Delivered",
      tracking_no: tracking_no || job.tracking_no || "",
      courier_name: courier_name || "",
      receiver_name: receiver_name || job.receiver_name || "",
      receiver_phone: receiver_phone || "",
      delivery_date: delivery_date ? new Date(delivery_date) : now,
      delivery_notes: delivery_notes || job.delivery_notes || "",
      payment_status: payment_status || (job.balance_amount <= 0 ? "paid" : job.is_credit ? "credit" : "partial"),
      credit_amount: credit_amount || (job.is_credit ? job.balance_amount : 0),
      delivered_by: {
        user_id: user._id || user.user_id || null,
        name: user.name || "Delivery Staff",
      },
      photos: Array.isArray(photos) && photos.length ? photos : job.delivery_photos || [],
      completed_at: now,
    };

    job.delivery_status = "delivered";
    job.job_status = "completed";
    job.status_updated_at = now;

    job.workflow_stages.push({
      stage: "completed",
      stage_label: "Job Completed",
      handled_by: {
        user_id: user._id || user.user_id || null,
        name: user.name || "Delivery Staff",
        role: user.role || "delivery team",
      },
      assigned_by: {
        user_id: user._id || user.user_id || null,
        name: user.name || "Delivery Staff",
      },
      action: "completed",
      assigned_at: now,
      started_at: now,
      completed_at: now,
      work_sessions: [],
      notes: delivery_notes || `Final delivery completed via ${delivery_method || "Delivered"}. Job marked as completed.`,
    });

    job.current_stage = {
      stage: "completed",
      stage_label: "Completed",
      stage_action: "completed",
      assigned_to: { user_id: null, name: "—", role: "" },
      since: now,
    };

    await job.save();
    return resp(res, 200, true, "Delivery completed and job marked as Completed.", toPlain(job));
  } catch (err) {
    console.error("completeJobDelivery ❌", err);
    return resp(res, 500, false, err.message);
  }
};

exports.assignQC = async (req, res) => {
  try {
    const { id } = req.params;
    const { assigned_to, assigned_by, notes } = req.body;

    if (!assigned_to?.user_id) {
      return resp(res, 400, false, "QC assignee is required.");
    }

    const job = await Job.findById(id);
    if (!job) return resp(res, 404, false, "Job not found.");

    const now = new Date();
    job.qc_assignee = {
      user_id: assigned_to.user_id,
      name: assigned_to.name || "QC Staff",
      role: assigned_to.role || "quality check",
    };

    if (job.job_status === "quality_check" || req.body.update_stage) {
      job.current_stage = {
        stage: "quality_check",
        stage_label: "Quality Check",
        stage_action: "assigned",
        assigned_to: job.qc_assignee,
        since: now,
      };
    }

    job.workflow_stages.push({
      stage: "quality_check",
      stage_label: "Quality Check",
      handled_by: job.qc_assignee,
      assigned_by: typeof assigned_by === "object" ? assigned_by : { user_id: req.user?._id || null, name: assigned_by || req.user?.name || "Admin" },
      action: "reassigned",
      assigned_at: now,
      notes: notes || `Quality Check assigned to ${assigned_to.name || "staff"}`,
    });

    await job.save();
    return resp(res, 200, true, `Quality Check assigned to ${assigned_to.name || "staff"}.`, { job: toPlain(job) });
  } catch (err) {
    console.error("❌ assignQC error:", err);
    return resp(res, 500, false, err.message);
  }
};





