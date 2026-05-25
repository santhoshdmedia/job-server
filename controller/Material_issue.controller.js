// ==================== MATERIAL ISSUE CONTROLLER ====================
// Handles the full lifecycle:
//   1. Calculate required material (preview before issuing)
//   2. Issue material from store to employee
//   3. Employee / manager records material return + wastage
//   4. Manager reviews performance
//   5. Reporting: per-job, per-employee, overall wastage analytics

const mongoose      = require("mongoose");
const MaterialIssue = require("../modals/Material_issue.model");

const Job        = require("../modals/job.modal");
const Product    = require("../modals/product.models");
const AdminUsers = require("../modals/adminusers.modals");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: standard JSON response
// ─────────────────────────────────────────────────────────────────────────────
const resp = (res, status, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null) payload.data = data;
  return res.status(status).json(payload);
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Decrement product.stock_count; logs a note
// ─────────────────────────────────────────────────────────────────────────────
const decrementStock = async (productId, qty, actorName, note) => {
  await Product.findByIdAndUpdate(productId, {
    $inc:  { stock_count: -qty },
    $push: {
      stock_log: {
        action:     "decrement",
        qty,
        actor_name: actorName,
        note,
        logged_at:  new Date(),
      },
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Increment product.stock_count on return
// ─────────────────────────────────────────────────────────────────────────────
const incrementStock = async (productId, qty, actorName, note) => {
  await Product.findByIdAndUpdate(productId, {
    $inc:  { stock_count: qty },
    $push: {
      stock_log: {
        action:     "increment",
        qty,
        actor_name: actorName,
        note,
        logged_at:  new Date(),
      },
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Build a human-readable return summary for the API response
// ─────────────────────────────────────────────────────────────────────────────
const buildReturnSummary = (issue) => {
  const r    = issue.return;
  const calc = issue.calculation;
  if (!r) return null;
  return {
    efficiency_pct: parseFloat(
      ((r.actual_used_qty / issue.issued_qty) * 100).toFixed(2)
    ),
    over_issued_sqft: parseFloat(
      (issue.issued_qty - calc.required_sqft).toFixed(4)
    ),
    actual_vs_expected_wastage: parseFloat(
      (r.actual_wastage_qty - r.expected_wastage_qty).toFixed(4)
    ),
    verdict:
      r.performance_rating === "good"
        ? "Great — material used efficiently."
        : r.performance_rating === "acceptable"
        ? "Within acceptable range."
        : "High wastage — flagged for review.",
  };
};

/** Same helper but works on plain lean() object */
const buildReturnSummaryFromLean = (issue) => buildReturnSummary(issue);

// ─────────────────────────────────────────────────────────────────────────────
// Internal: Compute aggregate totals across multiple issue records for a job
// ─────────────────────────────────────────────────────────────────────────────
const computeJobTotals = (issues) => {
  const result = {
    total_issues:       issues.length,
    pending_return:     0,
    total_issued_qty:   0,
    total_returned_qty: 0,
    total_wastage_qty:  0,
    avg_wastage_pct:    0,
    flagged_count:      0,
  };

  let ratioSum = 0, ratioCount = 0;

  for (const issue of issues) {
    result.total_issued_qty += issue.issued_qty || 0;
    if (!issue.return) {
      result.pending_return++;
    } else {
      result.total_returned_qty += issue.return.returned_qty || 0;
      result.total_wastage_qty  += issue.return.actual_wastage_qty || 0;
      if (issue.return.is_flagged) result.flagged_count++;
      ratioSum   += issue.return.wastage_ratio_pct || 0;
      ratioCount++;
    }
  }

  result.total_issued_qty   = parseFloat(result.total_issued_qty.toFixed(4));
  result.total_returned_qty = parseFloat(result.total_returned_qty.toFixed(4));
  result.total_wastage_qty  = parseFloat(result.total_wastage_qty.toFixed(4));
  result.avg_wastage_pct    = ratioCount
    ? parseFloat((ratioSum / ratioCount).toFixed(2))
    : 0;

  return result;
};

// =============================================================================
// 1. CALCULATE REQUIRED MATERIAL  (preview — no DB write)
// POST /api/material/calculate
// =============================================================================
exports.calculateMaterial = (req, res) => {
  try {
    const {
      width_ft,
      height_ft,
      margin_top_in      = 4,
      margin_bottom_in   = 3,
      wastage_buffer_pct = 20,
    } = req.body;

    if (!width_ft || !height_ft)
      return resp(res, 400, false, "width_ft and height_ft are required.");

    if (width_ft <= 0 || height_ft <= 0)
      return resp(res, 400, false, "Dimensions must be greater than 0.");

    const calc = MaterialIssue.calculateRequired({
      width_ft,
      height_ft,
      margin_top_in,
      margin_bottom_in,
      wastage_buffer_pct,
    });

    return resp(res, 200, true, "Material requirement calculated.", {
      dimensions: { width_ft, height_ft },
      margin_top_inches:    margin_top_in,
      margin_bottom_inches: margin_bottom_in,
      wastage_buffer_pct,
      ...calc,
      breakdown: {
        "1_job_print_area":    `${calc.job_sqft} sqft  (${width_ft}ft × ${height_ft}ft)`,
        "2_margin_area":       `${calc.margin_sqft} sqft  (${width_ft}ft × ${(margin_top_in + margin_bottom_in) / 12}ft margins)`,
        "3_gross_area":        `${calc.gross_sqft} sqft  (job + margins)`,
        "4_wastage_buffer":    `${wastage_buffer_pct}% of gross = ${parseFloat((calc.gross_sqft * wastage_buffer_pct / 100).toFixed(4))} sqft`,
        "5_total_recommended": `${calc.required_sqft} sqft  ← suggest issuing this much`,
      },
    });
  } catch (err) {
    console.error("calculateMaterial:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 2. ISSUE MATERIAL  (store manager → employee)
// POST /api/jobs/:jobId/material/issue
// =============================================================================
exports.issueMaterial = async (req, res) => {
  try {
    const { jobId } = req.params;
    const {
      cart_item_index     = 0,
      material,
      issued_qty,
      calc_mode           = "server",
      sq_ft,
      dimensions,
      margin_top_in       = 4,
      margin_bottom_in    = 3,
      wastage_buffer_pct  = 20,
      outsource_type      = "none",
      outsource_vendor    = "",
      issued_to,
      issued_by,
      issue_notes         = "",
    } = req.body;

    // ── Determine outsource mode FIRST — everything else branches on this ────
    const isOutsourced = outsource_type && outsource_type !== "none";

    // ── Validate required fields ─────────────────────────────────────────────
    if (!material?.product_id)
      return resp(res, 400, false, "material.product_id is required.");

    if (!issued_qty || issued_qty <= 0)
      return resp(res, 400, false, "issued_qty must be greater than 0.");

    if (!issued_by?.user_id || !issued_by?.name)
      return resp(res, 400, false, "issued_by.user_id and issued_by.name are required.");

    if (isOutsourced) {
      if (!outsource_vendor?.trim())
        return resp(res, 400, false, "outsource_vendor is required for outsourced work.");
      if (!issued_to?.name && !outsource_vendor?.trim())
        return resp(res, 400, false, "issued_to.name or outsource_vendor is required for outsourced work.");
    } else {
      if (!issued_to?.user_id || !issued_to?.name)
        return resp(res, 400, false, "issued_to.user_id and issued_to.name are required.");
    }

    // ── Validate outsource_type enum ─────────────────────────────────────────
    const validOutsourceTypes = [
      "none", "printing", "lamination", "fabrication",
      "installation", "cutting", "full_job", "other",
    ];
    if (!validOutsourceTypes.includes(outsource_type))
      return resp(res, 400, false,
        `outsource_type must be one of: ${validOutsourceTypes.join(", ")}.`
      );

    // ── Mode-specific dimension validation ───────────────────────────────────
    if (calc_mode === "sqft") {
      const parsedSqFt = parseFloat(sq_ft);
      if (!parsedSqFt || parsedSqFt <= 0)
        return resp(res, 400, false,
          "sq_ft must be greater than 0 when calc_mode is 'sqft'."
        );
    } else {
      if (!dimensions?.width || !dimensions?.height)
        return resp(res, 400, false,
          "dimensions.width and dimensions.height are required when calc_mode is 'server'."
        );
    }

    // ── Validate job ─────────────────────────────────────────────────────────
    const job = await Job.findById(jobId).lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    // ── Validate product ─────────────────────────────────────────────────────
    const product = await Product.findById(material.product_id).lean();
    if (!product) return resp(res, 404, false, "Material product not found.");

    // ── Validate employee (only for in-house) ────────────────────────────────
    if (!isOutsourced) {
      const employee = await AdminUsers.findById(issued_to.user_id).lean();
      if (!employee) return resp(res, 404, false, "Employee (issued_to) not found.");
    }

    // ── Stock check ──────────────────────────────────────────────────────────
    const available = product.stock_count || 0;
    if (available < issued_qty)
      return resp(res, 400, false,
        `Insufficient stock for "${product.name}". Available: ${available} ${material.unit || "sqft"}, Requested: ${issued_qty}`
      );

    // ── Build calculation snapshot ───────────────────────────────────────────
    const buf = parseFloat(wastage_buffer_pct) || 0;

    let calc;
    let dimensionRecord;

    if (calc_mode === "sqft") {
      const cartSqFt = parseFloat(sq_ft);
      const wastage  = parseFloat((cartSqFt * buf / 100).toFixed(4));
      const required = parseFloat((cartSqFt + wastage).toFixed(4));

      calc = {
        job_sqft:             cartSqFt,
        margin_sqft:          0,
        gross_sqft:           cartSqFt,
        wastage_buffer_pct:   buf,
        buffer_sqft:          wastage,
        required_sqft:        required,
        margin_top_inches:    0,
        margin_bottom_inches: 0,
      };
      dimensionRecord = {
        width:  dimensions?.width  || 0,
        height: dimensions?.height || 0,
        unit:   "ft",
      };
    } else {
      calc = MaterialIssue.calculateRequired({
        width_ft:           dimensions.width,
        height_ft:          dimensions.height,
        margin_top_in,
        margin_bottom_in,
        wastage_buffer_pct: buf,
      });
      dimensionRecord = {
        width:  dimensions.width,
        height: dimensions.height,
        unit:   dimensions.unit || "ft",
      };
    }

    // ── Generate issue number ────────────────────────────────────────────────
    const issue_no       = await MaterialIssue.generateIssueNo();
    const cartItem       = job.cart_items?.[cart_item_index];
    const cart_item_name = cartItem?.product_name || "";

    // ── Resolve issued_to name — prefer outsource_vendor for outsourced jobs ─
    const resolvedIssuedToName = isOutsourced
      ? (outsource_vendor.trim() || issued_to?.name || "")
      : (issued_to?.name || "");

    const resolvedOutsourceVendor = isOutsourced ? outsource_vendor.trim() : "";

    // ── Create issue record ──────────────────────────────────────────────────
    const issue = await MaterialIssue.create({
      issue_no,
      job_id:          jobId,
      job_no:          job.job_no,
      calc_mode,
      sq_ft:           calc_mode === "sqft" ? parseFloat(sq_ft) : null,
      cart_item_index,
      cart_item_name,
      material: {
        product_id:   material.product_id,
        product_name: product.name,
        unit:         material.unit || "sqft",
      },
      issued_qty,
      suggested_qty: calc.required_sqft,
      issued_at:     new Date(),
      issued_to: {
        user_id: isOutsourced ? null : issued_to.user_id,
        name:    resolvedIssuedToName,
        role:    isOutsourced ? "outsource" : (issued_to.role || ""),
      },
      issued_by: {
        user_id: issued_by.user_id,
        name:    issued_by.name,
        role:    issued_by.role || "",
      },
      dimensions: dimensionRecord,
      calculation: {
        job_sqft:             calc.job_sqft,
        margin_sqft:          calc.margin_sqft,
        gross_sqft:           calc.gross_sqft,
        wastage_buffer_pct:   buf,
        buffer_sqft:          parseFloat((calc.gross_sqft * buf / 100).toFixed(4)),
        required_sqft:        calc.required_sqft,
        margin_top_inches:    calc_mode === "server" ? (parseFloat(margin_top_in)    || 0) : 0,
        margin_bottom_inches: calc_mode === "server" ? (parseFloat(margin_bottom_in) || 0) : 0,
      },
      issue_notes,
      outsource_type,
      outsource_vendor: resolvedOutsourceVendor,
      status: "issued",
    });

    // ── FIX: Write outsource info back into the Job's cart_items array ───────
    // This ensures the Job document also reflects outsource_vendor and
    // outsource_type so it's visible when querying the Job directly.
    await Job.findByIdAndUpdate(jobId, {
      $set: {
        [`cart_items.${cart_item_index}.outsource_type`]:   outsource_type,
        [`cart_items.${cart_item_index}.outsource_vendor`]: resolvedOutsourceVendor,
        [`cart_items.${cart_item_index}.material_issue_id`]: issue._id,
        [`cart_items.${cart_item_index}.issued_qty`]:        issued_qty,
        [`cart_items.${cart_item_index}.issued_by`]: {
          user_id: issued_by.user_id,
          name:    issued_by.name,
          role:    issued_by.role || "",
        },
        [`cart_items.${cart_item_index}.issued_to`]: {
          user_id: isOutsourced ? null : issued_to.user_id,
          name:    resolvedIssuedToName,
          role:    isOutsourced ? "outsource" : (issued_to.role || ""),
        },
      },
    });

    // ── Decrement stock ──────────────────────────────────────────────────────
    await decrementStock(
      material.product_id,
      issued_qty,
      issued_by.name,
      `Issued for job ${job.job_no} (Issue: ${issue_no})`
    );

    return resp(res, 201, true, `Material issued successfully. Issue No: ${issue_no}`, {
      issue_no,
      issue_id:         issue._id,
      job_no:           job.job_no,
      material_name:    product.name,
      issued_qty,
      suggested_qty:    calc.required_sqft,
      issued_to:        resolvedIssuedToName,
      outsource_type,
      outsource_vendor: resolvedOutsourceVendor,
      calculation:      calc,
      stock_remaining:  parseFloat((available - issued_qty).toFixed(4)),
    });
  } catch (err) {
    console.error("issueMaterial:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 3. RECORD PRODUCTION COMPLETION
// POST /api/material/:issueId/production
// =============================================================================
exports.recordProductionCompletion = async (req, res) => {
  try {
    const { issueId } = req.params;
    const {
      machine_name                = "",
      ink_used                    = [],
      ink_notes                   = "",
      production_started_at       = null,
      production_completed_at     = null,
      production_duration_seconds = 0,
    } = req.body;

    if (!machine_name?.trim())
      return resp(res, 400, false, "machine_name is required.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue) return resp(res, 404, false, "Material issue record not found.");

    if (!Array.isArray(ink_used))
      return resp(res, 400, false, "ink_used must be an array.");
    for (const ink of ink_used) {
      if (!ink.color?.trim())
        return resp(res, 400, false, "Each ink entry must have a color field.");
      if (ink.quantity < 0)
        return resp(res, 400, false, "Ink quantity cannot be negative.");
    }

    issue.applyProductionCompletion({
      machine_name,
      ink_used,
      ink_notes,
      production_started_at,
      production_completed_at,
      production_duration_seconds,
    });

    await issue.save();

    return resp(res, 200, true, "Production metadata saved.", {
      issue_no:                    issue.issue_no,
      machine_name:                issue.machine_name,
      ink_used:                    issue.ink_used,
      ink_notes:                   issue.ink_notes,
      production_duration_display: issue.production_duration_display,
      production_started_at:       issue.production_started_at,
      production_completed_at:     issue.production_completed_at,
    });
  } catch (err) {
    console.error("recordProductionCompletion:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 4. RECORD RETURN
// POST /api/material/:issueId/return
// =============================================================================
exports.recordReturn = async (req, res) => {
  try {
    const { issueId } = req.params;
    const {
      returned_qty,
      wastage_reason               = "margin_trim",
      wastage_reason_notes         = "",
      returned_by                  = {},
      machine_name                 = "",
      ink_used                     = [],
      ink_notes                    = "",
      production_started_at        = null,
      production_completed_at      = null,
      production_duration_seconds  = 0,
    } = req.body;

    if (returned_qty === undefined || returned_qty === null)
      return resp(res, 400, false, "returned_qty is required (use 0 if nothing returned).");
    if (returned_qty < 0)
      return resp(res, 400, false, "returned_qty cannot be negative.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue)
      return resp(res, 404, false, "Material issue record not found.");

    if (issue.status === "returned" || issue.status === "no_return")
      return resp(res, 409, false,
        `Return already recorded for issue ${issue.issue_no}. Use the review endpoint to add manager notes.`
      );

    if (returned_qty > issue.issued_qty)
      return resp(res, 400, false,
        `Returned qty (${returned_qty}) cannot exceed issued qty (${issue.issued_qty}).`
      );

    // ── Save production metadata only if not already set ─────────────────────
    const alreadyHasProductionData =
      issue.machine_name ||
      (issue.ink_used && issue.ink_used.length > 0) ||
      issue.production_duration_seconds > 0;

    if (!alreadyHasProductionData) {
      issue.applyProductionCompletion({
        machine_name,
        ink_used,
        ink_notes,
        production_started_at,
        production_completed_at,
        production_duration_seconds,
      });
    }

    // ── Apply return + wastage calculation ────────────────────────────────────
    issue.applyReturn({
      returned_qty,
      wastage_reason,
      wastage_reason_notes,
      returned_by,
    });

    await issue.save();

    // ── Stock increment ───────────────────────────────────────────────────────
    if (returned_qty > 0) {
      await incrementStock(
        issue.material.product_id,
        returned_qty,
        returned_by.name || "",
        `Return from job ${issue.job_no} (Issue: ${issue.issue_no})`
      );
    }

    const ret = issue.return;

    return resp(res, 200, true, "Material return recorded successfully.", {
      issue_no:                    issue.issue_no,
      job_no:                      issue.job_no,
      status:                      issue.status,
      issued_qty:                  issue.issued_qty,
      returned_qty:                ret.returned_qty,
      actual_used_qty:             ret.actual_used_qty,
      expected_used_qty:           ret.expected_used_qty,
      actual_wastage_qty:          ret.actual_wastage_qty,
      expected_wastage_qty:        ret.expected_wastage_qty,
      wastage_ratio_pct:           ret.wastage_ratio_pct,
      performance_rating:          ret.performance_rating,
      is_flagged:                  ret.is_flagged,
      wastage_reason:              ret.wastage_reason,
      saved_qty:                   ret.saved_qty,
      machine_name:                issue.machine_name                || null,
      ink_used:                    issue.ink_used                    || [],
      ink_notes:                   issue.ink_notes                   || null,
      production_duration_seconds: issue.production_duration_seconds || 0,
      production_duration_display: issue.production_duration_display || "00:00:00",
      summary:                     buildReturnSummary(issue),
    });
  } catch (err) {
    console.error("recordReturn:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 5. MANAGER REVIEW  (first-time review)
// POST /api/material/:issueId/review
// =============================================================================
exports.managerReview = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { manager_by, manager_notes = "", override_rating = null } = req.body;

    if (!manager_by?.user_id || !manager_by?.name)
      return resp(res, 400, false, "manager_by.user_id and manager_by.name are required.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue) return resp(res, 404, false, "Material issue record not found.");

    if (!issue.return)
      return resp(res, 400, false,
        `No return recorded yet for issue ${issue.issue_no}. Record the return first.`
      );

    if (issue.return.manager_reviewed)
      return resp(res, 409, false,
        `Issue ${issue.issue_no} has already been reviewed. Use PUT /api/material/:issueId/review to update.`
      );

    issue.applyManagerReview({ manager_by, manager_notes, override_rating });
    await issue.save();

    return resp(res, 200, true, "Manager review recorded.", {
      issue_no:           issue.issue_no,
      job_no:             issue.job_no,
      employee:           issue.issued_to.name,
      performance_rating: issue.return.performance_rating,
      is_flagged:         issue.return.is_flagged,
      manager_notes:      issue.return.manager_notes,
      reviewed_by:        issue.return.manager_review_by.name,
      reviewed_at:        issue.return.manager_review_at,
    });
  } catch (err) {
    console.error("managerReview:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 6. UPDATE MANAGER REVIEW  (correct / update an existing review)
// PUT /api/material/:issueId/review
// =============================================================================
exports.updateManagerReview = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { manager_by, manager_notes, override_rating } = req.body;

    if (!manager_by?.user_id)
      return resp(res, 400, false, "manager_by is required.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue)        return resp(res, 404, false, "Material issue record not found.");
    if (!issue.return) return resp(res, 400, false, "No return recorded yet.");

    if (manager_notes !== undefined)  issue.return.manager_notes    = manager_notes;
    if (manager_by)                   issue.return.manager_review_by = manager_by;
    issue.return.manager_review_at = new Date();
    issue.return.manager_reviewed  = true;

    if (override_rating && ["good", "acceptable", "high_wastage"].includes(override_rating)) {
      issue.return.performance_rating = override_rating;
      issue.return.is_flagged         = override_rating === "high_wastage";
    }

    await issue.save();
    return resp(res, 200, true, "Manager review updated.", { issue_no: issue.issue_no });
  } catch (err) {
    console.error("updateManagerReview:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 7. GET ALL MATERIAL ISSUES FOR A JOB
// GET /api/jobs/:jobId/material
// =============================================================================
exports.getJobMaterials = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(jobId))
      return resp(res, 400, false, "Invalid jobId.");

    const issues = await MaterialIssue.find({ job_id: jobId, is_deleted: false })
      .sort({ createdAt: -1 })
      .populate("issued_to.user_id",   "name role email")
      .populate("issued_by.user_id",   "name role")
      .populate("material.product_id", "name stock_count")
      .lean();

    const totals = computeJobTotals(issues);

    return resp(res, 200, true, "Material issues for job fetched.", {
      job_id: jobId,
      issues,
      totals,
    });
  } catch (err) {
    console.error("getJobMaterials:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 8. GET SINGLE MATERIAL ISSUE
// GET /api/material/:issueId
// =============================================================================
exports.getMaterialIssue = async (req, res) => {
  try {
    const issue = await MaterialIssue.findById(req.params.issueId)
      .populate("issued_to.user_id",   "name role email")
      .populate("issued_by.user_id",   "name role")
      .populate("material.product_id", "name stock_count stocks_status")
      .populate("job_id",              "job_no job_status current_stage")
      .lean();

    if (!issue) return resp(res, 404, false, "Material issue not found.");

    return resp(res, 200, true, "Material issue fetched.", {
      ...issue,
      summary: issue.return ? buildReturnSummaryFromLean(issue) : null,
    });
  } catch (err) {
    console.error("getMaterialIssue:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 9. GET MATERIAL ISSUES BY EMPLOYEE
// GET /api/material/employee/:userId?status=returned&page=1&limit=20
// =============================================================================
exports.getEmployeeMaterials = async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      status,
      page       = 1,
      limit      = 20,
      sort_by    = "createdAt",
      sort_order = "desc",
    } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId))
      return resp(res, 400, false, "Invalid userId.");

    const filter = {
      "issued_to.user_id": new mongoose.Types.ObjectId(userId),
      is_deleted: false,
    };
    if (status) filter.status = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const sort  = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total = await MaterialIssue.countDocuments(filter);

    const issues = await MaterialIssue.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("material.product_id", "name")
      .lean();

    const allReturned = issues.filter(i => i.return);
    const avgWastage  = allReturned.length
      ? parseFloat(
          (allReturned.reduce((s, i) => s + (i.return.wastage_ratio_pct || 0), 0) /
            allReturned.length).toFixed(2)
        )
      : 0;

    const ratingCounts = allReturned.reduce((acc, i) => {
      const r = i.return.performance_rating || "acceptable";
      acc[r]  = (acc[r] || 0) + 1;
      return acc;
    }, {});

    return resp(res, 200, true, "Employee material issues fetched.", {
      user_id: userId,
      issues,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
      employee_stats: {
        total_issues:       total,
        returned_count:     allReturned.length,
        pending_return:     total - allReturned.length,
        avg_wastage_pct:    avgWastage,
        performance_counts: ratingCounts,
        overall_rating:     MaterialIssue.ratePerformance(avgWastage),
      },
    });
  } catch (err) {
    console.error("getEmployeeMaterials:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 10. GET ALL MATERIAL ISSUES (with filters + pagination)
// GET /api/material?status=issued&employee_id=...&product_id=...&page=1&limit=20
// =============================================================================
exports.getAllMaterialIssues = async (req, res) => {
  try {
    const {
      status,
      employee_id,
      product_id,
      job_no,
      is_flagged,
      manager_reviewed,
      outsource_type,
      page       = 1,
      limit      = 20,
      sort_by    = "createdAt",
      sort_order = "desc",
    } = req.query;

    const filter = { is_deleted: false };

    if (status)           filter.status                     = status;
    if (job_no)           filter.job_no                     = new RegExp(job_no, "i");
    if (is_flagged)       filter["return.is_flagged"]       = is_flagged === "true";
    if (outsource_type)   filter.outsource_type             = outsource_type;
    if (manager_reviewed !== undefined)
                          filter["return.manager_reviewed"] = manager_reviewed === "true";

    if (employee_id && mongoose.Types.ObjectId.isValid(employee_id))
      filter["issued_to.user_id"] = new mongoose.Types.ObjectId(employee_id);

    if (product_id && mongoose.Types.ObjectId.isValid(product_id))
      filter["material.product_id"] = new mongoose.Types.ObjectId(product_id);

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const sort  = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total = await MaterialIssue.countDocuments(filter);

    const issues = await MaterialIssue.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("issued_to.user_id",   "name role")
      .populate("material.product_id", "name")
      .lean();

    return resp(res, 200, true, "Material issues fetched.", {
      issues,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getAllMaterialIssues:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 11. WASTAGE ANALYTICS REPORT
// GET /api/material/report/wastage?from=2024-01-01&to=2024-12-31&employee_id=...
// =============================================================================
exports.wastageReport = async (req, res) => {
  try {
    const { from, to, employee_id, product_id } = req.query;

    const matchStage = { is_deleted: false, status: { $in: ["returned", "no_return"] } };

    if (from || to) {
      matchStage.createdAt = {};
      if (from) matchStage.createdAt.$gte = new Date(from);
      if (to)   matchStage.createdAt.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    if (employee_id && mongoose.Types.ObjectId.isValid(employee_id))
      matchStage["issued_to.user_id"] = new mongoose.Types.ObjectId(employee_id);

    if (product_id && mongoose.Types.ObjectId.isValid(product_id))
      matchStage["material.product_id"] = new mongoose.Types.ObjectId(product_id);

    // ── Overall summary ──────────────────────────────────────────────────────
    const [overall] = await MaterialIssue.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:                    null,
          total_records:          { $sum: 1 },
          total_issued_qty:       { $sum: "$issued_qty" },
          total_returned_qty:     { $sum: "$return.returned_qty" },
          total_actual_used:      { $sum: "$return.actual_used_qty" },
          total_actual_wastage:   { $sum: "$return.actual_wastage_qty" },
          total_expected_wastage: { $sum: "$return.expected_wastage_qty" },
          avg_wastage_ratio:      { $avg: "$return.wastage_ratio_pct" },
          flagged_count:          { $sum: { $cond: ["$return.is_flagged", 1, 0] } },
          good_count:             { $sum: { $cond: [{ $eq: ["$return.performance_rating", "good"] },        1, 0] } },
          acceptable_count:       { $sum: { $cond: [{ $eq: ["$return.performance_rating", "acceptable"] },  1, 0] } },
          high_wastage_count:     { $sum: { $cond: [{ $eq: ["$return.performance_rating", "high_wastage"] },1, 0] } },
        },
      },
    ]);

    // ── Per-employee breakdown ───────────────────────────────────────────────
    const byEmployee = await MaterialIssue.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:               "$issued_to.user_id",
          employee_name:     { $first: "$issued_to.name" },
          employee_role:     { $first: "$issued_to.role" },
          total_issues:      { $sum: 1 },
          total_issued:      { $sum: "$issued_qty" },
          total_returned:    { $sum: "$return.returned_qty" },
          total_wastage:     { $sum: "$return.actual_wastage_qty" },
          avg_wastage_ratio: { $avg: "$return.wastage_ratio_pct" },
          flagged:           { $sum: { $cond: ["$return.is_flagged", 1, 0] } },
        },
      },
      {
        $addFields: {
          overall_rating: {
            $switch: {
              branches: [
                { case: { $lte: ["$avg_wastage_ratio", 10] }, then: "good" },
                { case: { $lte: ["$avg_wastage_ratio", 20] }, then: "acceptable" },
              ],
              default: "high_wastage",
            },
          },
          avg_wastage_ratio: { $round: ["$avg_wastage_ratio", 2] },
        },
      },
      { $sort: { avg_wastage_ratio: -1 } },
    ]);

    // ── Per-material breakdown ───────────────────────────────────────────────
    const byMaterial = await MaterialIssue.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:               "$material.product_id",
          material_name:     { $first: "$material.product_name" },
          unit:              { $first: "$material.unit" },
          total_issued:      { $sum: "$issued_qty" },
          total_returned:    { $sum: "$return.returned_qty" },
          total_wastage:     { $sum: "$return.actual_wastage_qty" },
          avg_wastage_ratio: { $avg: "$return.wastage_ratio_pct" },
          issue_count:       { $sum: 1 },
        },
      },
      {
        $addFields: {
          avg_wastage_ratio: { $round: ["$avg_wastage_ratio", 2] },
        },
      },
      { $sort: { total_wastage: -1 } },
    ]);

    // ── Wastage reason breakdown ─────────────────────────────────────────────
    const byReason = await MaterialIssue.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:           "$return.wastage_reason",
          count:         { $sum: 1 },
          total_wastage: { $sum: "$return.actual_wastage_qty" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // ── Outsource type breakdown ─────────────────────────────────────────────
    const byOutsourceType = await MaterialIssue.aggregate([
      {
        $match: {
          is_deleted: false,
          ...(from || to ? { createdAt: matchStage.createdAt } : {}),
        },
      },
      {
        $group: {
          _id:           "$outsource_type",
          count:         { $sum: 1 },
          total_issued:  { $sum: "$issued_qty" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    return resp(res, 200, true, "Wastage report generated.", {
      period: { from: from || "all time", to: to || "now" },
      overall: overall
        ? {
            ...overall,
            _id:               undefined,
            avg_wastage_ratio: parseFloat((overall.avg_wastage_ratio || 0).toFixed(2)),
            wastage_saved_qty: parseFloat(((overall.total_returned_qty || 0)).toFixed(4)),
          }
        : null,
      by_employee:       byEmployee,
      by_material:       byMaterial,
      by_wastage_reason: byReason,
      by_outsource_type: byOutsourceType,
    });
  } catch (err) {
    console.error("wastageReport:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 12. GET FLAGGED ISSUES (pending manager review)
// GET /api/material/flagged?page=1&limit=20
// =============================================================================
exports.getFlaggedIssues = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const filter = {
      is_deleted:                false,
      "return.is_flagged":       true,
      "return.manager_reviewed": false,
    };

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await MaterialIssue.countDocuments(filter);

    const issues = await MaterialIssue.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("issued_to.user_id",   "name role email")
      .populate("material.product_id", "name")
      .lean();

    return resp(res, 200, true, "Flagged issues fetched.", {
      issues,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("getFlaggedIssues:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 13. DELETE MATERIAL ISSUE (soft delete — only if status = "issued" and no return yet)
// DELETE /api/material/:issueId
// =============================================================================
exports.deleteMaterialIssue = async (req, res) => {
  try {
    const issue = await MaterialIssue.findById(req.params.issueId);
    if (!issue) return resp(res, 404, false, "Material issue not found.");

    if (issue.status !== "issued")
      return resp(res, 400, false,
        `Cannot delete issue ${issue.issue_no}. Only unprocessed (status=issued) records can be deleted.`
      );

    // ── Restore stock before soft-deleting ───────────────────────────────────
    await incrementStock(
      issue.material.product_id,
      issue.issued_qty,
      "System",
      `Reversal — deleted issue ${issue.issue_no}`
    );

    // ── FIX: Clear outsource fields from Job cart_item on delete ─────────────
    await Job.findByIdAndUpdate(issue.job_id, {
      $unset: {
        [`cart_items.${issue.cart_item_index}.outsource_type`]:    "",
        [`cart_items.${issue.cart_item_index}.outsource_vendor`]:  "",
        [`cart_items.${issue.cart_item_index}.material_issue_id`]: "",
        [`cart_items.${issue.cart_item_index}.issued_qty`]:        "",
        [`cart_items.${issue.cart_item_index}.issued_by`]:         "",
        [`cart_items.${issue.cart_item_index}.issued_to`]:         "",
      },
    });

    issue.is_deleted = true;
    await issue.save();

    return resp(res, 200, true, `Material issue ${issue.issue_no} deleted and stock restored.`);
  } catch (err) {
    console.error("deleteMaterialIssue:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 14. LIST ISSUES (simple version — used by internal tools)
// GET /material?limit=50&status=issued&job_id=xxx&flagged=true
// =============================================================================
exports.listIssues = async (req, res) => {
  try {
    const {
      limit   = 50,
      page    = 1,
      status,
      job_id,
      flagged,
    } = req.query;

    const filter = { is_deleted: { $ne: true } };
    if (status)             filter.status                = status;
    if (job_id)             filter.job_id                = job_id;
    if (flagged === "true") filter["return.is_flagged"]  = true;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    return resp(res, 200, true, "Issues fetched.", {
      issues,
      pagination: {
        total,
        page:        parseInt(page),
        limit:       parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("listIssues:", err);
    return resp(res, 500, false, err.message);
  }
};