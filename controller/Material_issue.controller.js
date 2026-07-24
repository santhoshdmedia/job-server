// ==================== MATERIAL ISSUE CONTROLLER ====================
// Handles the full lifecycle:
//   1.  Calculate required material (preview)
//   2.  Issue material — four calc modes: server | sqft | dimensions | outsource
//   3.  Record production completion
//   4.  Record material return + wastage
//   5.  Manager review
//   6.  Pickup assignment — assign, update status, get by person
//   7.  Reporting

const mongoose      = require("mongoose");
const MaterialIssue = require("../modals/Material_issue.model");
const Job           = require("../modals/job.modal");
const Product       = require("../modals/product.models");
const AdminUsers    = require("../modals/adminusers.modals");

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
const resp = (res, status, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null) payload.data = data;
  return res.status(status).json(payload);
};

const toFeet = (val, unit = "ft") => {
  const v = parseFloat(val) || 0;
  switch (unit) {
    case "in": return v / 12;
    case "m":  return v * 3.28084;
    case "cm": return v / 30.48;
    default:   return v;
  }
};

const decrementStock = async (productId, qty, actorName, note) => {
  if (!productId) return;
  await Product.findByIdAndUpdate(productId, {
    $inc:  { stock_count: -qty },
    $push: { stock_log: { action: "decrement", qty, actor_name: actorName, note, logged_at: new Date() } },
  });
};

const incrementStock = async (productId, qty, actorName, note) => {
  if (!productId) return;
  await Product.findByIdAndUpdate(productId, {
    $inc:  { stock_count: qty },
    $push: { stock_log: { action: "increment", qty, actor_name: actorName, note, logged_at: new Date() } },
  });
};

const buildReturnSummary = (issue) => {
  const r    = issue.return;
  const calc = issue.calculation;
  if (!r) return null;
  return {
    efficiency_pct:             parseFloat(((r.actual_used_qty / issue.issued_qty) * 100).toFixed(2)),
    over_issued_sqft:           parseFloat((issue.issued_qty - (calc.required_sqft || 0)).toFixed(4)),
    actual_vs_expected_wastage: parseFloat((r.actual_wastage_qty - r.expected_wastage_qty).toFixed(4)),
    verdict:
      r.performance_rating === "good"        ? "Great — material used efficiently."
      : r.performance_rating === "acceptable" ? "Within acceptable range."
      :                                         "High wastage — flagged for review.",
  };
};

const computeJobTotals = (issues) => {
  const result = {
    total_issues: issues.length, pending_return: 0,
    total_issued_qty: 0, total_returned_qty: 0, total_wastage_qty: 0,
    avg_wastage_pct: 0, flagged_count: 0,
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
  result.avg_wastage_pct    = ratioCount ? parseFloat((ratioSum / ratioCount).toFixed(2)) : 0;
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal: build the calculation snapshot from request body
// ─────────────────────────────────────────────────────────────────────────────
const buildCalculation = ({
  calc_mode, sq_ft, dimensions, printing_dimensions, media_dimensions,
  margin_top_in, margin_bottom_in, wastage_buffer_pct, outsource_type,
}) => {
  const buf           = parseFloat(wastage_buffer_pct) || 0;
  const isOut         = outsource_type && outsource_type !== "none";
  const effectiveMode = isOut ? "outsource" : (calc_mode || "server");

  let calc;
  let dimensionRecord = { width: 0, height: 0, unit: "ft" };
  let printDim  = null;
  let mediaDim  = null;
  let wastageSq = 0;

  if (effectiveMode === "outsource") {
    const pFtW = printing_dimensions ? toFeet(printing_dimensions.width,  printing_dimensions.unit || printing_dimensions.width_unit)  : 0;
    const pFtH = printing_dimensions ? toFeet(printing_dimensions.height, printing_dimensions.unit || printing_dimensions.height_unit) : 0;
    const mFtW = media_dimensions    ? toFeet(media_dimensions.width,     media_dimensions.unit    || media_dimensions.width_unit)     : 0;
    const mFtH = media_dimensions    ? toFeet(media_dimensions.height,    media_dimensions.unit    || media_dimensions.height_unit)    : 0;
    const pSq  = parseFloat((pFtW * pFtH).toFixed(4));
    const mSq  = parseFloat((mFtW * mFtH).toFixed(4));

    calc = {
      print_sqft: pSq, media_sqft: mSq,
      wastage_sqft: parseFloat((mSq - pSq).toFixed(4)),
      wastage_buffer_pct: 0, buffer_sqft: 0, required_sqft: mSq,
    };
    if (printing_dimensions) printDim = { width: printing_dimensions.width, height: printing_dimensions.height, unit: printing_dimensions.unit || "ft", sqft: pSq };
    if (media_dimensions)    mediaDim = { width: media_dimensions.width,    height: media_dimensions.height,    unit: media_dimensions.unit    || "ft", sqft: mSq };
    wastageSq = parseFloat((mSq - pSq).toFixed(4));

  } else if (effectiveMode === "dimensions") {
    const pd    = printing_dimensions || {};
    const md    = media_dimensions    || {};
    const pUnit = pd.unit || pd.width_unit || "ft";
    const mUnit = md.unit || md.width_unit || "ft";
    const pFtW  = toFeet(pd.width,  pUnit);
    const pFtH  = toFeet(pd.height, pUnit);
    const mFtW  = toFeet(md.width,  mUnit);
    const mFtH  = toFeet(md.height, mUnit);
    const pSq   = parseFloat((pFtW * pFtH).toFixed(4));
    const mSq   = parseFloat((mFtW * mFtH).toFixed(4));
    const waste = parseFloat((mSq - pSq).toFixed(4));
    const bufSq = parseFloat((mSq * buf / 100).toFixed(4));
    const req   = parseFloat((mSq + bufSq).toFixed(4));

    printDim   = { width: pd.width, height: pd.height, unit: pUnit, sqft: pSq };
    mediaDim   = { width: md.width, height: md.height, unit: mUnit, sqft: mSq };
    wastageSq  = Math.max(0, waste);
    calc = {
      print_sqft: pSq, media_sqft: mSq, wastage_sqft: wastageSq,
      wastage_buffer_pct: buf, buffer_sqft: bufSq, required_sqft: req,
      job_sqft: pSq, gross_sqft: mSq, margin_sqft: 0,
      margin_top_inches: 0, margin_bottom_inches: 0,
    };
    dimensionRecord = { width: md.width || 0, height: md.height || 0, unit: mUnit };

  } else if (effectiveMode === "sqft") {
    const cartSqFt = parseFloat(sq_ft);
    const bufSq    = parseFloat((cartSqFt * buf / 100).toFixed(4));
    const req      = parseFloat((cartSqFt + bufSq).toFixed(4));
    calc = {
      job_sqft: cartSqFt, margin_sqft: 0, gross_sqft: cartSqFt,
      print_sqft: cartSqFt, media_sqft: cartSqFt, wastage_sqft: 0,
      wastage_buffer_pct: buf, buffer_sqft: bufSq, required_sqft: req,
      margin_top_inches: 0, margin_bottom_inches: 0,
    };
    if (dimensions) dimensionRecord = { width: dimensions.width || 0, height: dimensions.height || 0, unit: "ft" };

  } else {
    // server mode
    const serverCalc = MaterialIssue.calculateRequired({
      width_ft:           dimensions.width,
      height_ft:          dimensions.height,
      margin_top_in:      parseFloat(margin_top_in)    || 4,
      margin_bottom_in:   parseFloat(margin_bottom_in) || 3,
      wastage_buffer_pct: buf,
    });
    calc = {
      job_sqft:             serverCalc.job_sqft,
      margin_sqft:          serverCalc.margin_sqft,
      gross_sqft:           serverCalc.gross_sqft,
      print_sqft:           serverCalc.job_sqft,
      media_sqft:           serverCalc.gross_sqft,
      wastage_sqft:         parseFloat((serverCalc.gross_sqft - serverCalc.job_sqft).toFixed(4)),
      wastage_buffer_pct:   buf,
      buffer_sqft:          parseFloat((serverCalc.gross_sqft * buf / 100).toFixed(4)),
      required_sqft:        serverCalc.required_sqft,
      margin_top_inches:    parseFloat(margin_top_in)    || 4,
      margin_bottom_inches: parseFloat(margin_bottom_in) || 3,
    };
    dimensionRecord = { width: dimensions.width, height: dimensions.height, unit: dimensions.unit || "ft" };
  }

  return { calc, dimensionRecord, printDim, mediaDim, wastageSq, effectiveMode };
};

// =============================================================================
// 1. CALCULATE REQUIRED MATERIAL  (preview — no DB write)
// POST /api/material/calculate
// =============================================================================
exports.calculateMaterial = (req, res) => {
  try {
    const { width_ft, height_ft, margin_top_in = 4, margin_bottom_in = 3, wastage_buffer_pct = 20 } = req.body;
    if (!width_ft || !height_ft)         return resp(res, 400, false, "width_ft and height_ft are required.");
    if (width_ft <= 0 || height_ft <= 0) return resp(res, 400, false, "Dimensions must be greater than 0.");

    const calc = MaterialIssue.calculateRequired({ width_ft, height_ft, margin_top_in, margin_bottom_in, wastage_buffer_pct });

    return resp(res, 200, true, "Material requirement calculated.", {
      dimensions: { width_ft, height_ft },
      margin_top_inches: margin_top_in, margin_bottom_inches: margin_bottom_in,
      wastage_buffer_pct, ...calc,
      breakdown: {
        "1_job_print_area":    `${calc.job_sqft} sqft`,
        "2_margin_area":       `${calc.margin_sqft} sqft`,
        "3_gross_area":        `${calc.gross_sqft} sqft`,
        "4_wastage_buffer":    `${wastage_buffer_pct}% = ${parseFloat((calc.gross_sqft * wastage_buffer_pct / 100).toFixed(4))} sqft`,
        "5_total_recommended": `${calc.required_sqft} sqft`,
      },
    });
  } catch (err) {
    console.error("calculateMaterial:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 2. ISSUE MATERIAL  (store manager → employee / outsource vendor)
// POST /api/jobs/:jobId/material/issue
// =============================================================================
exports.issueMaterial = async (req, res) => {
  try {
    const { jobId } = req.params;
    const {
      cart_item_index     = 0,
      cart_item_id        = "",
      material,
      issued_qty,
      calc_mode           = "server",
      sq_ft,
      dimensions,
      printing_dimensions,
      media_dimensions,
      margin_top_in       = 4,
      margin_bottom_in    = 3,
      wastage_buffer_pct  = 20,
      outsource_type      = "none",
      outsource_vendor    = "",
      issued_to,
      issued_by,
      issue_notes         = "",
      design_file_id      = null,
      design_file_label   = "",
    } = req.body;

    const isOutsourced = outsource_type && outsource_type !== "none";

    // ── Validation ───────────────────────────────────────────────────────────
    if (!isOutsourced && !material?.product_id)
      return resp(res, 400, false, "material.product_id is required for in-house issues.");
    if (issued_qty === undefined || issued_qty === null)
      return resp(res, 400, false, "issued_qty is required (use 0 for outsource with no qty).");
    if (!issued_by?.user_id || !issued_by?.name)
      return resp(res, 400, false, "issued_by.user_id and issued_by.name are required.");
    if (isOutsourced && !outsource_vendor?.trim())
      return resp(res, 400, false, "outsource_vendor is required for outsourced work.");

    if (!isOutsourced) {
      if (calc_mode === "sqft" && (!parseFloat(sq_ft) || parseFloat(sq_ft) <= 0))
        return resp(res, 400, false, "sq_ft must be > 0 when calc_mode is 'sqft'.");
      if (calc_mode === "server" && (!dimensions?.width || !dimensions?.height))
        return resp(res, 400, false, "dimensions.width and height required when calc_mode is 'server'.");
      if (calc_mode === "dimensions" && (!printing_dimensions || !media_dimensions))
        return resp(res, 400, false, "printing_dimensions and media_dimensions required when calc_mode is 'dimensions'.");
    }

    // ── Fetch job ────────────────────────────────────────────────────────────
    const job = await Job.findById(jobId).lean();
    if (!job) return resp(res, 404, false, "Job not found.");

    // ── Stock check ──────────────────────────────────────────────────────────
    let product = null;
    if (!isOutsourced && material?.product_id) {
      product = await Product.findById(material.product_id).lean();
      if (!product) return resp(res, 404, false, "Material product not found.");
      const available = product.stock_count || 0;
      const qtyNeeded = parseFloat(issued_qty) || 0;
      if (available < qtyNeeded)
        return resp(res, 400, false,
          `Insufficient stock for "${product.name}". Available: ${available}, Requested: ${qtyNeeded}`
        );
    }

    // ── Resolve issued_to ────────────────────────────────────────────────────
    let resolvedIssuedTo = { user_id: null, name: "", role: "" };
    if (isOutsourced) {
      resolvedIssuedTo = { user_id: null, name: outsource_vendor.trim(), role: "outsource" };
    } else {
      if (issued_to?.user_id) {
        resolvedIssuedTo = { user_id: issued_to.user_id, name: issued_to.name || "", role: issued_to.role || "" };
      } else if (design_file_id) {
        const cartItem   = job.cart_items?.[cart_item_index];
        const designFile = cartItem?.design_files?.find(f => f._id?.toString() === design_file_id);
        if (designFile?.assigned_to?.user_id) {
          resolvedIssuedTo = {
            user_id: designFile.assigned_to.user_id,
            name:    designFile.assigned_to.name || "",
            role:    designFile.assigned_to.role || "",
          };
        }
      }
      if (resolvedIssuedTo.user_id) {
        const employee = await AdminUsers.findById(resolvedIssuedTo.user_id).lean();
        if (!employee) console.warn(`issueMaterial: employee ${resolvedIssuedTo.user_id} not found`);
      }
    }

    // ── Build calculation ────────────────────────────────────────────────────
    const { calc, dimensionRecord, printDim, mediaDim, wastageSq, effectiveMode } = buildCalculation({
      calc_mode, sq_ft, dimensions, printing_dimensions, media_dimensions,
      margin_top_in, margin_bottom_in, wastage_buffer_pct, outsource_type,
    });

    // ── Create record ────────────────────────────────────────────────────────
    const issue_no       = await MaterialIssue.generateIssueNo();
    const cartItem       = job.cart_items?.[cart_item_index];
    const cart_item_name = cartItem?.product_name || cartItem?.name || "";
    const qty            = parseFloat(issued_qty) || 0;
    const resolvedVendor = isOutsourced ? outsource_vendor.trim() : "";

    const issue = await MaterialIssue.create({
      issue_no,
      job_id:          jobId,
      job_no:          job.job_no,
      calc_mode:       effectiveMode,
      sq_ft:           effectiveMode === "sqft" ? parseFloat(sq_ft) : null,
      cart_item_index,
      cart_item_id:    cart_item_id || cartItem?.item_id || "",
      cart_item_name,
      design_file_id:    design_file_id ? new mongoose.Types.ObjectId(design_file_id) : null,
      design_file_label: design_file_label || "",
      material: {
        product_id:   isOutsourced ? null : material?.product_id,
        product_name: isOutsourced ? "Outsourced" : (product?.name || ""),
        unit:         material?.unit || "sqft",
      },
      issued_qty:    qty,
      suggested_qty: calc.required_sqft,
      issued_at:     new Date(),
      issued_to:     resolvedIssuedTo,
      issued_by: {
        user_id: issued_by.user_id,
        name:    issued_by.name,
        role:    issued_by.role || "",
      },
      dimensions:          dimensionRecord,
      printing_dimensions: printDim,
      media_dimensions:    mediaDim,
      wastage_sqft:        wastageSq,
      calculation:         calc,
      issue_notes,
      outsource_type,
      outsource_vendor:    resolvedVendor,
      pickup_assignment:   null,
      status:              "issued",
    });

    // ── Write back to Job cart_item ──────────────────────────────────────────
    const cartUpdateFields = {
      [`cart_items.${cart_item_index}.outsource_type`]:    outsource_type,
      [`cart_items.${cart_item_index}.outsource_vendor`]:  resolvedVendor,
      [`cart_items.${cart_item_index}.material_issue_id`]: issue._id,
      [`cart_items.${cart_item_index}.issued_qty`]:        qty,
      [`cart_items.${cart_item_index}.issued_by`]:         { user_id: issued_by.user_id, name: issued_by.name, role: issued_by.role || "" },
      [`cart_items.${cart_item_index}.issued_to`]:         resolvedIssuedTo,
    };
    if (design_file_id) {
      cartUpdateFields[`cart_items.${cart_item_index}.design_files.$[file].material_issue_id`] = issue._id;
    }
    await Job.findByIdAndUpdate(
      jobId,
      { $set: cartUpdateFields },
      design_file_id ? { arrayFilters: [{ "file._id": new mongoose.Types.ObjectId(design_file_id) }] } : {}
    );

    // ── Decrement stock (SKIP for outsource) ─────────────────────────────────
    if (!isOutsourced && material?.product_id && qty > 0) {
      await decrementStock(material.product_id, qty, issued_by.name,
        `Issued for job ${job.job_no} (Issue: ${issue_no})`);
    }

    return resp(res, 201, true, `Material issued. Issue No: ${issue_no}`, {
      issue_no, issue_id: issue._id, job_no: job.job_no,
      material_name: issue.material.product_name,
      issued_qty: qty, suggested_qty: calc.required_sqft,
      issued_to: resolvedIssuedTo.name,
      outsource_type, outsource_vendor: resolvedVendor,
      calc_mode: effectiveMode,
      printing_dimensions: printDim, media_dimensions: mediaDim,
      wastage_sqft: wastageSq, calculation: calc,
      stock_remaining: product ? parseFloat((product.stock_count - qty).toFixed(4)) : null,
    });
  } catch (err) {
    console.error("issueMaterial:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 2b. ISSUE MATERIAL FOR A SPECIFIC DESIGN FILE
// POST /api/jobs/:jobId/items/:itemId/design-files/:fileId/material/issue
// =============================================================================
exports.issueForDesignFile = async (req, res) => {
  const { jobId, itemId, fileId } = req.params;
  const job = await Job.findById(jobId).lean();
  if (!job) return resp(res, 404, false, "Job not found.");

  const idx = job.cart_items?.findIndex(i => i.item_id === itemId || i._id?.toString() === itemId);
  if (idx === -1 || idx === undefined) return resp(res, 404, false, "Cart item not found.");

  const item = job.cart_items[idx];
  const file = item.design_files?.find(f => f._id?.toString() === fileId);
  if (!file) return resp(res, 404, false, "Design file not found on cart item.");

  req.body.cart_item_index   = idx;
  req.body.cart_item_id      = itemId;
  req.body.design_file_id    = fileId;
  req.body.design_file_label = file.label || "";
  return exports.issueMaterial(req, res);
};

// =============================================================================
// 3. RECORD PRODUCTION COMPLETION
// POST /api/material/:issueId/production
// =============================================================================
exports.recordProductionCompletion = async (req, res) => {
  try {
    const { issueId } = req.params;
    const {
      machines = [],
      production_notes = "",
      production_photos = [],
      production_started_at = null,
      production_completed_at = null,
      production_duration_seconds = 0,
    } = req.body;

    const issue = await MaterialIssue.findById(issueId);
    if (!issue) return resp(res, 404, false, "Material issue record not found.");

    if (!Array.isArray(machines) || machines.length === 0)
      return resp(res, 400, false, "machines must be a non-empty array.");

    for (const m of machines) {
      if (!m.machine_id?.trim())   return resp(res, 400, false, "Each machine must have a machine_id.");
      if (!m.machine_name?.trim()) return resp(res, 400, false, "Each machine must have a machine_name.");
      if ((m.printing_time_mins ?? 0) < 0 || (m.machine_run_time_mins ?? 0) < 0)
        return resp(res, 400, false, "Machine times cannot be negative.");
      if (!Array.isArray(m.inks))
        return resp(res, 400, false, `Machine "${m.machine_name}" must have an inks array.`);
      for (const ink of m.inks) {
        if (!ink.color?.trim())    return resp(res, 400, false, "Each ink entry must have a color.");
        if ((ink.quantity ?? 0) < 0) return resp(res, 400, false, "Ink quantity cannot be negative.");
      }
    }

    if (!Array.isArray(production_photos))
      return resp(res, 400, false, "production_photos must be an array.");

    issue.applyProductionCompletion({
      machines,
      production_notes,
      production_photos,
      production_started_at,
      production_completed_at,
      production_duration_seconds,
    });
    await issue.save();

    return resp(res, 200, true, "Production metadata saved.", {
      issue_no:                    issue.issue_no,
      machines:                    issue.machines,
      production_notes:            issue.production_notes,
      production_photos:           issue.production_photos,
      production_status:           issue.production_status,
      production_duration_display: issue.production_duration_display,
    });
  } catch (err) {
    console.error("recordProductionCompletion:", err);
    return resp(res, 500, false, err.message);
  }
};
// =============================================================================
// 3b. REASSIGN PRODUCTION TASK TO ANOTHER STAFF MEMBER
// POST /api/material/:issueId/reassign
//
// Body:
//   new_assignee { user_id, name?, role? }  — staff member taking over the task
//   reassigned_by { user_id, name?, role? } — manager/super admin doing the reassignment (optional)
//
// Rules:
//   • Only valid for in-house work (not outsource — outsource hand-offs go
//     through assign-pickup instead).
//   • Cannot reassign a task that's already been completed and returned.
//   • Mirrors the change onto the parent Job's cart_item so both records
//     stay in sync (same pattern issueMaterial uses when it first sets
//     issued_to).
// =============================================================================
exports.reassignIssuedTo = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { new_assignee, reassigned_by = {} } = req.body;

    if (!new_assignee?.user_id)
      return resp(res, 400, false, "new_assignee.user_id is required.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue) return resp(res, 404, false, "Material issue record not found.");

    if (issue.calc_mode === "outsource")
      return resp(res, 400, false, "Outsourced tasks are reassigned via assign-pickup, not this endpoint.");

    if (["returned", "no_return"].includes(issue.status))
      return resp(res, 409, false, `${issue.issue_no} is already completed and cannot be reassigned.`);

    const employee = await AdminUsers.findById(new_assignee.user_id).lean();
    if (!employee) return resp(res, 404, false, "Selected staff member was not found.");

    const previousAssignee = issue.issued_to ? { ...issue.issued_to.toObject?.() ?? issue.issued_to } : null;

    const resolvedAssignee = {
      user_id: employee._id,
      name:    new_assignee.name || employee.name || "",
      role:    new_assignee.role || employee.role || "",
    };

    issue.issued_to = resolvedAssignee;
    await issue.save();

    // ── Mirror onto the parent Job's cart_item so both stay in sync ──────────
    await Job.findByIdAndUpdate(issue.job_id, {
      $set: { [`cart_items.${issue.cart_item_index}.issued_to`]: resolvedAssignee },
    });

    return resp(res, 200, true, `Task reassigned to ${resolvedAssignee.name}.`, {
      issue_no: issue.issue_no,
      job_no:   issue.job_no,
      previous_assignee: previousAssignee,
      issued_to: resolvedAssignee,
      reassigned_by,
      reassigned_at: new Date(),
    });
  } catch (err) {
    console.error("reassignIssuedTo:", err);
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
      returned_qty, wastage_reason = "margin_trim", wastage_reason_notes = "",
      returned_by = {}, machine_name = "", ink_used = [], ink_notes = "", machines = [],
      production_started_at = null, production_completed_at = null,
      production_duration_seconds = 0,
    } = req.body;

    if (returned_qty === undefined || returned_qty === null)
      return resp(res, 400, false, "returned_qty is required (use 0 if nothing returned).");
    if (returned_qty < 0)
      return resp(res, 400, false, "returned_qty cannot be negative.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue) return resp(res, 404, false, "Material issue record not found.");
    if (["returned", "no_return"].includes(issue.status))
      return resp(res, 409, false, `Return already recorded for ${issue.issue_no}.`);
    if (returned_qty > issue.issued_qty)
      return resp(res, 400, false,
        `Returned qty (${returned_qty}) cannot exceed issued qty (${issue.issued_qty}).`);

    const alreadyHasProductionData =
      issue.machine_name || (issue.ink_used?.length > 0) || issue.production_duration_seconds > 0;
    if (!alreadyHasProductionData) {
      issue.applyProductionCompletion({ machine_name, ink_used, ink_notes, machines, production_started_at, production_completed_at, production_duration_seconds });
    }

    issue.applyReturn({ returned_qty, wastage_reason, wastage_reason_notes, returned_by });
    await issue.save();

    if (returned_qty > 0) {
      await incrementStock(issue.material.product_id, returned_qty, returned_by.name || "",
        `Return from job ${issue.job_no} (Issue: ${issue.issue_no})`);
    }

    const ret = issue.return;
    return resp(res, 200, true, "Material return recorded.", {
      issue_no: issue.issue_no, job_no: issue.job_no, status: issue.status,
      issued_qty: issue.issued_qty, returned_qty: ret.returned_qty,
      actual_used_qty: ret.actual_used_qty, actual_wastage_qty: ret.actual_wastage_qty,
      wastage_ratio_pct: ret.wastage_ratio_pct, performance_rating: ret.performance_rating,
      is_flagged: ret.is_flagged, summary: buildReturnSummary(issue),
    });
  } catch (err) {
    console.error("recordReturn:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 5. MANAGER REVIEW (first-time)
// POST /api/material/:issueId/review
// =============================================================================
exports.managerReview = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { manager_by, manager_notes = "", override_rating = null } = req.body;

    if (!manager_by?.user_id || !manager_by?.name)
      return resp(res, 400, false, "manager_by.user_id and manager_by.name are required.");

    const issue = await MaterialIssue.findById(issueId);
    if (!issue)         return resp(res, 404, false, "Material issue record not found.");
    if (!issue.return)  return resp(res, 400, false, `No return recorded yet for ${issue.issue_no}.`);
    if (issue.return.manager_reviewed)
      return resp(res, 409, false, `${issue.issue_no} already reviewed. Use PUT to update.`);

    issue.applyManagerReview({ manager_by, manager_notes, override_rating });
    await issue.save();

    return resp(res, 200, true, "Manager review recorded.", {
      issue_no: issue.issue_no, job_no: issue.job_no,
      performance_rating: issue.return.performance_rating, is_flagged: issue.return.is_flagged,
    });
  } catch (err) {
    console.error("managerReview:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 6. UPDATE MANAGER REVIEW
// PUT /api/material/:issueId/review
// =============================================================================
exports.updateManagerReview = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { manager_by, manager_notes, override_rating } = req.body;

    if (!manager_by?.user_id) return resp(res, 400, false, "manager_by is required.");
    const issue = await MaterialIssue.findById(issueId);
    if (!issue)        return resp(res, 404, false, "Material issue record not found.");
    if (!issue.return) return resp(res, 400, false, "No return recorded yet.");

    if (manager_notes !== undefined) issue.return.manager_notes    = manager_notes;
    if (manager_by)                  issue.return.manager_review_by = manager_by;
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
// 7. ASSIGN PICKUP
// POST /api/material/:issueId/assign-pickup
//
// Body:
//   assigned_to  { user_id, name?, role? }   — person who collects from vendor
//   delivery_to  "dmedia_office" | "factory" | "customer"
//   pickup_time  ISO-8601 datetime (must be in the future)
//   notes?       string
//   assigned_by  { user_id, name?, role? }   — manager making the assignment (optional)
//
// Rules:
//   • Issue must have calc_mode === "outsource"
//   • assigned_to.user_id must exist in admin_users collection
//   • Overwrites any previous assignment (re-assign supported)
// =============================================================================
exports.assignPickup = async (req, res) => {
  try {
    const { issueId } = req.params;
    const { assigned_to, delivery_to, pickup_time, notes = "", assigned_by = {} } = req.body;

    // ── Basic validation ──────────────────────────────────────────────────────
    if (!assigned_to?.user_id)
      return resp(res, 400, false, "assigned_to.user_id is required.");
    if (!mongoose.Types.ObjectId.isValid(assigned_to.user_id))
      return resp(res, 400, false, "assigned_to.user_id is not a valid ObjectId.");

    const VALID_DESTINATIONS = ["dmedia_office", "factory", "customer"];
    if (!delivery_to || !VALID_DESTINATIONS.includes(delivery_to))
      return resp(res, 400, false, `delivery_to must be one of: ${VALID_DESTINATIONS.join(", ")}.`);

    if (!pickup_time)
      return resp(res, 400, false, "pickup_time is required.");
    if (new Date(pickup_time) <= new Date())
      return resp(res, 400, false, "pickup_time must be a future datetime.");

    // ── Load issue ────────────────────────────────────────────────────────────
    const issue = await MaterialIssue.findById(issueId);
    if (!issue)           return resp(res, 404, false, "Material issue not found.");
    if (issue.is_deleted) return resp(res, 404, false, "Material issue has been deleted.");
    if (issue.calc_mode !== "outsource")
      return resp(res, 400, false, "Pickup assignment is only valid for outsource issues.");

    // ── Verify admin user exists ──────────────────────────────────────────────
    const assignee = await AdminUsers.findById(assigned_to.user_id).lean();
    if (!assignee)
      return resp(res, 404, false, `Admin user ${assigned_to.user_id} not found.`);

    // ── Apply via instance method ─────────────────────────────────────────────
    issue.applyPickupAssignment({
      assigned_to: {
        user_id: assignee._id,
        name:    assigned_to.name || assignee.name || "",
        role:    assigned_to.role || assignee.role || "",
      },
      delivery_to,
      pickup_time,
      notes,
      assigned_by,
    });

    await issue.save();

    const pa = issue.pickup_assignment;
    return resp(res, 200, true, "Pickup assignment saved.", {
      issue_no:    issue.issue_no,
      issue_id:    issue._id,
      job_no:      issue.job_no,
      pickup_assignment: {
        assigned_to:  pa.assigned_to,
        delivery_to:  pa.delivery_to,
        pickup_time:  pa.pickup_time,
        notes:        pa.notes,
        assigned_by:  pa.assigned_by,
        assigned_at:  pa.assigned_at,
        status:       pa.status,
      },
    });
  } catch (err) {
    console.error("assignPickup:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 8. UPDATE PICKUP STATUS
// PATCH /api/material/:issueId/pickup/status
//
// Body:
//   status  "collected" | "delivered" | "cancelled"
// =============================================================================
exports.updatePickupStatus = async (req, res) => {
  try {
    // BUG FIX: was using req.params.issueId but route registered the param as :issueId — consistent now
    const { issueId } = req.params;
    const { status }  = req.body;

    const ALLOWED = ["collected", "delivered", "cancelled"];
    if (!status || !ALLOWED.includes(status))
      return resp(res, 400, false, `status must be one of: ${ALLOWED.join(", ")}.`);

    const issue = await MaterialIssue.findById(issueId);
    if (!issue)           return resp(res, 404, false, "Material issue not found.");
    if (issue.is_deleted) return resp(res, 404, false, "Material issue has been deleted.");
    if (issue.calc_mode !== "outsource")
      return resp(res, 400, false, "Pickup status update is only valid for outsource issues.");
    if (!issue.pickup_assignment)
      return resp(res, 400, false, `No pickup assignment found on ${issue.issue_no}. Assign first.`);
    if (issue.pickup_assignment.status === "delivered")
      return resp(res, 409, false, "Pickup is already marked as delivered.");
    if (issue.pickup_assignment.status === "cancelled")
      return resp(res, 409, false, "Pickup has been cancelled and cannot be updated.");

    issue.updatePickupStatus(status);
    await issue.save();

    const pa = issue.pickup_assignment;
    return resp(res, 200, true, `Pickup status updated to "${status}".`, {
      issue_no:     issue.issue_no,
      pickup_status: pa.status,
      collected_at: pa.collected_at,
      delivered_at: pa.delivered_at,
    });
  } catch (err) {
    console.error("updatePickupStatus:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 9. GET PICKUPS BY USER
// GET /api/material/pickups/user/:userId?status=pending&page=1&limit=20
// =============================================================================
exports.getPickupsByUser = async (req, res) => {
  try {
    const { userId }                                            = req.params;
    const { status, page = 1, limit = 20, sort_order = "asc" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId))
      return resp(res, 400, false, "Invalid userId.");

    const filter = {
      is_deleted:  false,
      calc_mode:   "outsource",
      "pickup_assignment.assigned_to.user_id": new mongoose.Types.ObjectId(userId),
    };
    if (status) filter["pickup_assignment.status"] = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const sort  = { "pickup_assignment.pickup_time": sort_order === "desc" ? -1 : 1 };
    const total = await MaterialIssue.countDocuments(filter);

    const issues = await MaterialIssue.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("pickup_assignment.assigned_to.user_id", "name role email")
      .lean();

    const allForUser = await MaterialIssue.find({
      is_deleted: false, calc_mode: "outsource",
      "pickup_assignment.assigned_to.user_id": new mongoose.Types.ObjectId(userId),
    }).select("pickup_assignment.status").lean();

    const statusCounts = allForUser.reduce((acc, i) => {
      const s = i.pickup_assignment?.status || "pending";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    return resp(res, 200, true, "Pickups for user fetched.", {
      user_id: userId,
      issues,
      pagination: {
        total, page: parseInt(page), limit: parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
      summary: statusCounts,
    });
  } catch (err) {
    console.error("getPickupsByUser:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 10. GET ALL OUTSOURCE ISSUES
// GET /api/material/outsource?pickup_status=pending&page=1&limit=50
// =============================================================================
exports.getOutsourceIssues = async (req, res) => {
  try {
    const {
      pickup_status, outsource_type, job_no,
      page = 1, limit = 50, sort_by = "createdAt", sort_order = "desc",
    } = req.query;

    const filter = { is_deleted: false, calc_mode: "outsource" };
    if (outsource_type) filter.outsource_type = outsource_type;
    if (job_no)         filter.job_no         = new RegExp(job_no, "i");

    if (pickup_status === "unassigned") {
      filter.pickup_assignment = null;
    } else if (pickup_status) {
      filter["pickup_assignment.status"] = pickup_status;
    }

    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const sort   = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total  = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter)
      .sort(sort).skip(skip).limit(parseInt(limit))
      .populate("pickup_assignment.assigned_to.user_id", "name role email")
      .lean();

    const statusAgg = await MaterialIssue.aggregate([
      { $match: { is_deleted: false, calc_mode: "outsource" } },
      { $group: {
        _id: {
          $cond: [
            { $eq: ["$pickup_assignment", null] }, "unassigned",
            "$pickup_assignment.status",
          ],
        },
        count: { $sum: 1 },
      }},
    ]);
    const pickupCounts = statusAgg.reduce((acc, r) => {
      acc[r._id] = r.count; return acc;
    }, {});

    return resp(res, 200, true, "Outsource issues fetched.", {
      issues,
      pagination: {
        total, page: parseInt(page), limit: parseInt(limit),
        total_pages: Math.ceil(total / parseInt(limit)),
      },
      pickup_status_counts: pickupCounts,
    });
  } catch (err) {
    console.error("getOutsourceIssues:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 11. GET ALL MATERIAL ISSUES FOR A JOB
// GET /api/jobs/:jobId/material
// =============================================================================
exports.getJobMaterials = async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(jobId))
      return resp(res, 400, false, "Invalid jobId.");

    const issues = await MaterialIssue.find({ job_id: jobId, is_deleted: false })
      .sort({ createdAt: -1 })
      .populate("issued_to.user_id",       "name role email")
      .populate("issued_by.user_id",       "name role")
      .populate("material.product_id",     "name stock_count")
      .populate("pickup_assignment.assigned_to.user_id", "name role email")
      .lean();

    return resp(res, 200, true, "Material issues for job fetched.", {
      job_id: jobId, issues, totals: computeJobTotals(issues),
    });
  } catch (err) {
    console.error("getJobMaterials:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 12. GET MATERIAL ISSUES FOR A SPECIFIC CART ITEM
// GET /api/jobs/:jobId/items/:itemId/material
// =============================================================================
exports.getItemMaterials = async (req, res) => {
  try {
    const { jobId, itemId } = req.params;
    const issues = await MaterialIssue.find({
      job_id: jobId, cart_item_id: itemId, is_deleted: false,
    }).sort({ createdAt: -1 }).lean();
    return resp(res, 200, true, "Item material issues fetched.", { issues, totals: computeJobTotals(issues) });
  } catch (err) {
    console.error("getItemMaterials:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 13. GET MATERIAL ISSUES FOR A SPECIFIC DESIGN FILE
// GET /api/material/by-file/:fileId
// =============================================================================
exports.getIssuesByDesignFile = async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(fileId))
      return resp(res, 400, false, "Invalid fileId.");
    const issues = await MaterialIssue.find({
      design_file_id: new mongoose.Types.ObjectId(fileId), is_deleted: false,
    }).sort({ createdAt: -1 }).lean();
    return resp(res, 200, true, "Issues for design file fetched.", { issues });
  } catch (err) {
    console.error("getIssuesByDesignFile:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 14. GET SINGLE MATERIAL ISSUE
// GET /api/material/:issueId
// =============================================================================
exports.getMaterialIssue = async (req, res) => {
  try {
    const issue = await MaterialIssue.findById(req.params.issueId)
      .populate("issued_to.user_id",   "name role email")
      .populate("issued_by.user_id",   "name role")
      .populate("material.product_id", "name stock_count stocks_status")
      .populate("job_id",              "job_no job_status current_stage")
      .populate("pickup_assignment.assigned_to.user_id", "name role email")
      .lean();

    if (!issue) return resp(res, 404, false, "Material issue not found.");
    return resp(res, 200, true, "Material issue fetched.", {
      ...issue, summary: issue.return ? buildReturnSummary(issue) : null,
    });
  } catch (err) {
    console.error("getMaterialIssue:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 15. GET MATERIAL ISSUES BY EMPLOYEE
// GET /api/material/employee/:userId
// =============================================================================
exports.getEmployeeMaterials = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, page = 1, limit = 20, sort_by = "createdAt", sort_order = "desc" } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId))
      return resp(res, 400, false, "Invalid userId.");

    const filter = { "issued_to.user_id": new mongoose.Types.ObjectId(userId), is_deleted: false };
    if (status) filter.status = status;

    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const sort   = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total  = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter).sort(sort).skip(skip).limit(parseInt(limit))
      .populate("material.product_id", "name").lean();

    const allReturned = issues.filter(i => i.return);
    const avgWastage  = allReturned.length
      ? parseFloat((allReturned.reduce((s, i) => s + (i.return.wastage_ratio_pct || 0), 0) / allReturned.length).toFixed(2))
      : 0;
    const ratingCounts = allReturned.reduce((acc, i) => {
      const r = i.return.performance_rating || "acceptable";
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {});

    return resp(res, 200, true, "Employee material issues fetched.", {
      user_id: userId, issues,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) },
      employee_stats: {
        total_issues: total, returned_count: allReturned.length,
        pending_return: total - allReturned.length,
        avg_wastage_pct: avgWastage, performance_counts: ratingCounts,
        overall_rating: MaterialIssue.ratePerformance(avgWastage),
      },
    });
  } catch (err) {
    console.error("getEmployeeMaterials:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 16. GET ALL MATERIAL ISSUES (filtered + paginated)
// GET /api/material?status=issued&employee_id=...&page=1&limit=20
// =============================================================================
exports.getAllMaterialIssues = async (req, res) => {
  try {
    const {
      status, employee_id, product_id, job_no, is_flagged,
      manager_reviewed, outsource_type, page = 1, limit = 20,
      sort_by = "createdAt", sort_order = "desc",
    } = req.query;

    const filter = { is_deleted: false };
    if (status)         filter.status               = status;
    if (job_no)         filter.job_no               = new RegExp(job_no, "i");
    if (is_flagged)     filter["return.is_flagged"]  = is_flagged === "true";
    if (outsource_type) filter.outsource_type        = outsource_type;
    if (manager_reviewed !== undefined)
      filter["return.manager_reviewed"] = manager_reviewed === "true";
    if (employee_id && mongoose.Types.ObjectId.isValid(employee_id))
      filter["issued_to.user_id"] = new mongoose.Types.ObjectId(employee_id);
    if (product_id && mongoose.Types.ObjectId.isValid(product_id))
      filter["material.product_id"] = new mongoose.Types.ObjectId(product_id);

    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const sort   = { [sort_by]: sort_order === "asc" ? 1 : -1 };
    const total  = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter).sort(sort).skip(skip).limit(parseInt(limit))
      .populate("issued_to.user_id",   "name role")
      .populate("material.product_id", "name")
      .populate("pickup_assignment.assigned_to.user_id", "name role")
      .lean();

    return resp(res, 200, true, "Material issues fetched.", {
      issues,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error("getAllMaterialIssues:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 17. WASTAGE ANALYTICS REPORT
// GET /api/material/report/wastage?from=...&to=...
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

    const [overall] = await MaterialIssue.aggregate([
      { $match: matchStage },
      { $group: {
        _id: null,
        total_records:          { $sum: 1 },
        total_issued_qty:       { $sum: "$issued_qty" },
        total_returned_qty:     { $sum: "$return.returned_qty" },
        total_actual_used:      { $sum: "$return.actual_used_qty" },
        total_actual_wastage:   { $sum: "$return.actual_wastage_qty" },
        total_expected_wastage: { $sum: "$return.expected_wastage_qty" },
        avg_wastage_ratio:      { $avg: "$return.wastage_ratio_pct" },
        flagged_count:          { $sum: { $cond: ["$return.is_flagged", 1, 0] } },
        good_count:             { $sum: { $cond: [{ $eq: ["$return.performance_rating", "good"] }, 1, 0] } },
        acceptable_count:       { $sum: { $cond: [{ $eq: ["$return.performance_rating", "acceptable"] }, 1, 0] } },
        high_wastage_count:     { $sum: { $cond: [{ $eq: ["$return.performance_rating", "high_wastage"] }, 1, 0] } },
      }},
    ]);

    const byEmployee = await MaterialIssue.aggregate([
      { $match: matchStage },
      { $group: {
        _id: "$issued_to.user_id", employee_name: { $first: "$issued_to.name" },
        employee_role: { $first: "$issued_to.role" }, total_issues: { $sum: 1 },
        total_issued: { $sum: "$issued_qty" }, total_returned: { $sum: "$return.returned_qty" },
        total_wastage: { $sum: "$return.actual_wastage_qty" },
        avg_wastage_ratio: { $avg: "$return.wastage_ratio_pct" },
        flagged: { $sum: { $cond: ["$return.is_flagged", 1, 0] } },
      }},
      { $addFields: {
        overall_rating: { $switch: {
          branches: [
            { case: { $lte: ["$avg_wastage_ratio", 10] }, then: "good" },
            { case: { $lte: ["$avg_wastage_ratio", 20] }, then: "acceptable" },
          ],
          default: "high_wastage",
        }},
        avg_wastage_ratio: { $round: ["$avg_wastage_ratio", 2] },
      }},
      { $sort: { avg_wastage_ratio: -1 } },
    ]);

    const byMaterial = await MaterialIssue.aggregate([
      { $match: matchStage },
      { $group: {
        _id: "$material.product_id", material_name: { $first: "$material.product_name" },
        unit: { $first: "$material.unit" }, total_issued: { $sum: "$issued_qty" },
        total_returned: { $sum: "$return.returned_qty" }, total_wastage: { $sum: "$return.actual_wastage_qty" },
        avg_wastage_ratio: { $avg: "$return.wastage_ratio_pct" }, issue_count: { $sum: 1 },
      }},
      { $addFields: { avg_wastage_ratio: { $round: ["$avg_wastage_ratio", 2] } } },
      { $sort: { total_wastage: -1 } },
    ]);

    const byReason = await MaterialIssue.aggregate([
      { $match: matchStage },
      { $group: { _id: "$return.wastage_reason", count: { $sum: 1 }, total_wastage: { $sum: "$return.actual_wastage_qty" } } },
      { $sort: { count: -1 } },
    ]);

    const byOutsourceType = await MaterialIssue.aggregate([
      { $match: { is_deleted: false, ...(from || to ? { createdAt: matchStage.createdAt } : {}) } },
      { $group: { _id: "$outsource_type", count: { $sum: 1 }, total_issued: { $sum: "$issued_qty" } } },
      { $sort: { count: -1 } },
    ]);

    return resp(res, 200, true, "Wastage report generated.", {
      period: { from: from || "all time", to: to || "now" },
      overall: overall ? { ...overall, _id: undefined, avg_wastage_ratio: parseFloat((overall.avg_wastage_ratio || 0).toFixed(2)) } : null,
      by_employee: byEmployee, by_material: byMaterial,
      by_wastage_reason: byReason, by_outsource_type: byOutsourceType,
    });
  } catch (err) {
    console.error("wastageReport:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 18. GET FLAGGED ISSUES
// GET /api/material/flagged?page=1&limit=20
// =============================================================================
exports.getFlaggedIssues = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = { is_deleted: false, "return.is_flagged": true, "return.manager_reviewed": false };
    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const total  = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
      .populate("issued_to.user_id",   "name role email")
      .populate("material.product_id", "name").lean();

    return resp(res, 200, true, "Flagged issues fetched.", {
      issues,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error("getFlaggedIssues:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 19. DELETE MATERIAL ISSUE (soft delete)
// DELETE /api/material/:issueId
// =============================================================================
exports.deleteMaterialIssue = async (req, res) => {
  try {
    const issue = await MaterialIssue.findById(req.params.issueId);
    if (!issue) return resp(res, 404, false, "Material issue not found.");
    if (issue.status !== "issued")
      return resp(res, 400, false, `Cannot delete ${issue.issue_no} — only unprocessed (status=issued) records can be deleted.`);

    if (issue.outsource_type === "none" || !issue.outsource_type) {
      await incrementStock(issue.material.product_id, issue.issued_qty, "System", `Reversal — deleted ${issue.issue_no}`);
    }

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
    return resp(res, 200, true, `${issue.issue_no} deleted and stock restored.`);
  } catch (err) {
    console.error("deleteMaterialIssue:", err);
    return resp(res, 500, false, err.message);
  }
};

// =============================================================================
// 20. LIST ISSUES (simple — internal tools / store manager overview)
// GET /api/material/list?limit=50&status=issued&job_id=xxx&flagged=true
// =============================================================================
exports.listIssues = async (req, res) => {
  try {
    const { limit = 50, page = 1, status, job_id, flagged } = req.query;
    const filter = { is_deleted: { $ne: true } };
    if (status)             filter.status              = status;
    if (job_id)             filter.job_id              = job_id;
    if (flagged === "true") filter["return.is_flagged"] = true;

    const skip   = (parseInt(page) - 1) * parseInt(limit);
    const total  = await MaterialIssue.countDocuments(filter);
    const issues = await MaterialIssue.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean();

    return resp(res, 200, true, "Issues fetched.", {
      issues,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), total_pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error("listIssues:", err);
    return resp(res, 500, false, err.message);
  }
};