const { ProductSchema } = require("./models_import");
const { successResponse, errorResponse } = require("../helper/response.helper");
const {
  PRODUCT_ADDED_SUCCESS,
  PRODUCT_ADDED_FAILED,
  PRODUCT_GET_SUCCESS,
  PRODUCT_GET_FAILED,
  PRODUCT_DELETED_SUCCESS,
  PRODUCT_DELETED_FAILED,
  PRODUCT_EDITED_SUCCESS,
  PRODUCT_EDITED_FAILED,
} = require("../helper/message.helper");
const { default: mongoose } = require("mongoose");
const { ObjectId } = mongoose.Types;
const _ = require("lodash");
const { v4: uuidv4 } = require("uuid");

const {
  isAreaUnit,
  generateProductCodes,
  previewProductCodes,
} = require("../helper/Productcode.helper");

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Normalise the size object coming from the frontend.
 * Drops the whole object if both dimensions are absent.
 */
const normaliseSize = (size) => {
  if (!size) return null;
  const { width, height } = size;
  const hasAny =
    (width  != null && width  !== "") ||
    (height != null && height !== "");
  if (!hasAny) return null;
  return {
    width:       width  != null && width  !== "" ? Number(width)  : null,
    width_unit:  size.width_unit  || "feet",
    height:      height != null && height !== "" ? Number(height) : null,
    height_unit: size.height_unit || "feet",
    unit:        size.width_unit  || "feet",  // legacy compat
  };
};

/**
 * Rebuild the unit_stock_summary array from raw stock_info / stock_offline arrays.
 */
const buildUnitSummary = (stockInfo = [], stockOffline = [], fallbackUnit = "pcs") => {
  const map = {};
  const ensure = (unit) => {
    if (!map[unit]) map[unit] = { unit, total_in: 0, total_out: 0 };
  };
  stockInfo.forEach((e) => {
    const { qty = e.add_stock || 0, unit = fallbackUnit } = e.unit_qty || {};
    ensure(unit);
    map[unit].total_in += Number(qty);
  });
  stockOffline.forEach((e) => {
    const { qty = e.stock || 0, unit = fallbackUnit } = e.unit_qty || {};
    ensure(unit);
    map[unit].total_out += Number(qty);
  });
  return Object.values(map).map((r) => ({
    ...r,
    net_stock: r.total_in - r.total_out,
  }));
};

/**
 * Derive the current net stock for a specific unit from a summary array.
 */
const getNetStock = (summary = [], unit) =>
  (summary.find((s) => s.unit === unit) || {}).net_stock ?? 0;

/**
 * Recalculate remaining_area for a product doc from its stock_offline array.
 * Returns null when the product is not area-based.
 */
const computeRemainingArea = (product) => {
  const unit = product.primary_unit;
  if (!isAreaUnit(unit)) return null;

  const calculatedArea = product.calculated_area;
  if (calculatedArea == null) return null;

  const totalUsed = (product.stock_offline || []).reduce((sum, entry) => {
    return sum + (entry.area_used != null ? Number(entry.area_used) : Number(entry.unit_qty?.qty || entry.stock || 0));
  }, 0);

  return Math.max(0, calculatedArea - totalUsed);
};

// ─── ADD PRODUCT (batch-aware, server-driven code generation) ────────────────
/**
 * POST /products
 *
 * The frontend sends ONE payload describing the "template" product plus
 * `product_quantity` (how many physical units / DB documents to create).
 *
 * The backend:
 *   1. Reserves `product_quantity` sequential numbers from the GLOBAL counter
 *      (the sequence never resets, regardless of unit type / product name).
 *   2. Builds one product_code per reserved number using the name + size
 *      derived prefix (e.g. DMNF10X10-001, DMV3-002, DMP-003).
 *   3. Creates `product_quantity` separate documents, all sharing the same
 *      batch_id, each with its own product_code (and, for area-based units,
 *      its own independent remaining_area starting at calculated_area).
 *   4. For pcs/count-based units, each created product also gets its own
 *      stock_info / stock_count seeded from the payload (so "100 pcs" of
 *      Pen -> e.g. 1 product DMP-003 with stock_count 100, OR if the
 *      frontend instead requests product_quantity = 100 with qty 1 each,
 *      100 separate documents DMP-003..DMP-102 are created — both flows
 *      are supported because quantity-per-product vs number-of-products
 *      are independent fields).
 */
const addProduct = async (req, res) => {
  try {
    const body = { ...req.body };

    // Normalise size (kept for ALL unit types, used in code generation too)
    const normalisedSize = normaliseSize(body.size);

    const primaryUnit     = body.primary_unit || "pcs";
    const productQuantity = Math.max(1, Number(body.product_quantity) || 1);
    const isArea          = isAreaUnit(primaryUnit);

    // ── 1 & 2: reserve sequence numbers + build codes (server-driven) ───────
    const { codes } = await generateProductCodes({
      name:        body.name,
      primaryUnit,
      size:        normalisedSize,
      quantity:    productQuantity,
    });

    // ── Shared batch id for all siblings ─────────────────────────────────────
    const batchId = body.batch_id || uuidv4();

    // ── Stock entry template (shared shape across all siblings) ─────────────
    const baseStockEntry = {
      _id:          uuidv4(),
      add_stock:    body.stock_info?.[0]?.add_stock ?? 0,
      unit_qty:     body.stock_info?.[0]?.unit_qty ?? { qty: 0, unit: primaryUnit },
      handler_name: body.stock_info?.[0]?.handler_name || "",
      location:     body.stock_info?.[0]?.location     || "",
      invoice:      body.stock_info?.[0]?.invoice      || "",
      invoice_date: body.stock_info?.[0]?.invoice_date || null,
      notes:        body.stock_info?.[0]?.notes        || "",
      stock_images: body.stock_info?.[0]?.stock_images || [],
      date:         body.stock_info?.[0]?.date || new Date().toISOString(),
    };

    const calculatedArea = isArea && body.calculated_area != null
      ? Number(body.calculated_area)
      : null;

    // ── 3: build & insert one document per reserved code ────────────────────
    const docs = codes.map((code, idx) => {
      const stockEntry = {
        ...baseStockEntry,
        _id: uuidv4(), // unique per sibling
      };
      const stockQty = stockEntry.unit_qty?.qty || 0;

      const unitStockSummary = [{
        unit:      primaryUnit,
        total_in:  stockQty,
        total_out: 0,
        net_stock: stockQty,
      }];

      return {
        name:                   body.name,
        material_brand:         body.material_brand || "",
        type:                    body.type || "Stand Alone Product",
        size:                    normalisedSize,

        // ── Codes ──────────────────────────────────────────────────────────
        product_code:           code,
        product_codes:          codes,        // full sibling list on every doc
        batch_id:               batchId,
        product_quantity:       productQuantity,

        // ── Area tracking (independent per sibling) ─────────────────────────
        calculated_area:        calculatedArea,
        remaining_area:         isArea && calculatedArea != null ? calculatedArea : null,
        area_unit:              isArea && calculatedArea != null ? primaryUnit : null,

        // ── Pricing ───────────────────────────────────────────────────────
        MRP_price:              body.MRP_price || "",
        customer_product_price: body.customer_product_price || "",

        // ── Units & stock ────────────────────────────────────────────────
        primary_unit:           primaryUnit,
        supported_units:        body.supported_units?.length ? body.supported_units : [primaryUnit],
        unit_stock_summary:     unitStockSummary,
        stock_info:             [stockEntry],
        stock_offline:          [],
        stock_count:            stockQty,
        stocks_status:          stockQty > 10 ? "In Stock" : stockQty > 0 ? "Limited" : "Out of Stock",

        allocations:            [],
        allocation_stats: {
          total_allocated_qty: 0,
          total_returned_qty:  0,
          total_consumed_qty:  0,
          allocation_count:    0,
          stats_unit:          primaryUnit,
          ...(isArea ? { total_allocated_area: 0, total_returned_area: 0 } : {}),
        },

        is_visible: body.is_visible ?? false,
        is_cloned:  false,
      };
    });

    const created = await ProductSchema.insertMany(docs);
    return successResponse(res, PRODUCT_ADDED_SUCCESS, created);
  } catch (error) {
    console.error("addProduct error:", error);
    return errorResponse(res, PRODUCT_ADDED_FAILED);
  }
};

// ─── PREVIEW CODES (no sequence consumed) ─────────────────────────────────────
/**
 * POST /products/preview-codes
 *
 * Body: { name, primary_unit, size, quantity }
 * Returns: { codes: string[] }   — purely a PREVIEW, does not touch the counter.
 */
const previewCodes = async (req, res) => {
  try {
    const { name = "", primary_unit = "pcs", size = null, quantity = 1 } = req.body;

    if (!name || !String(name).trim()) {
      return successResponse(res, PRODUCT_GET_SUCCESS, { codes: [] });
    }

    const normalisedSize = normaliseSize(size);
    const { codes } = await previewProductCodes({
      name,
      primaryUnit: primary_unit || "pcs",
      size:        normalisedSize,
      quantity:    Math.max(1, Number(quantity) || 1),
    });

    return successResponse(res, PRODUCT_GET_SUCCESS, { codes });
  } catch (error) {
    console.error("previewCodes error:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── GET PRODUCTS ─────────────────────────────────────────────────────────────

const getProduct = async (req, res) => {
  const {
    filterByProduct_category    = "",
    filterByType                = "",
    filterByProduct_subcategory = "",
    search                      = "",
    vendor_filter               = "",
    id_list,
    visibility                  = "",
    material_brand              = "",
    size_unit                   = "",
    batch_id                    = "",
  } = req.query;

  const { id } = req.params;

  try {
    const where = {};

    if (id_list) {
      const list = JSON.parse(id_list);
      where.seo_url = { $in: list };
    }

    if (filterByType)                where.type                 = filterByType;
    if (filterByProduct_category)    where.category_details     = new ObjectId(filterByProduct_category);
    if (filterByProduct_subcategory) where.sub_category_details = new ObjectId(filterByProduct_subcategory);
    if (vendor_filter)               where.vendor_details       = new ObjectId(vendor_filter);
    if (batch_id)                    where.batch_id             = batch_id;

    if (visibility === "true")       where.is_visible = true;
    else if (visibility === "false") where.is_visible = false;

    if (search) {
      where.$or = [
        { name:             { $regex: search, $options: "i" } },
        { product_code:     { $regex: search, $options: "i" } },
        { product_codeS_NO: { $regex: search, $options: "i" } },
        { Vendor_Code:      { $regex: search, $options: "i" } },
        { batch_id:         { $regex: search, $options: "i" } },
      ];
    }

    if (material_brand) {
      where.material_brand = { $regex: material_brand, $options: "i" };
    }

    if (size_unit) {
      where.$or = [
        { "size.width_unit":  size_unit },
        { "size.height_unit": size_unit },
        { "size.unit":        size_unit },
      ];
    }

    if (id) {
      where.seo_url = id;
    }

    const result = await ProductSchema.find(where).lean();
    return successResponse(res, PRODUCT_GET_SUCCESS, result);
  } catch (error) {
    console.error("getProduct error:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── EDIT PRODUCT ─────────────────────────────────────────────────────────────

const editProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const body = { ...req.body };

    if ("size" in body) {
      body.size = normaliseSize(body.size);
    }

    const product = await ProductSchema.findById(id).lean();
    if (!product) return errorResponse(res, PRODUCT_EDITED_FAILED);

    const stockInfo    = body.stock_info    ?? product.stock_info    ?? [];
    const stockOffline = body.stock_offline ?? product.stock_offline ?? [];
    const primaryUnit  = body.primary_unit  ?? product.primary_unit  ?? "pcs";

    if ("stock_info" in body || "stock_offline" in body) {
      body.unit_stock_summary = buildUnitSummary(stockInfo, stockOffline, primaryUnit);
      const primarySummary    = body.unit_stock_summary.find((s) => s.unit === primaryUnit);
      body.stock_count        = primarySummary ? primarySummary.net_stock : 0;
    }

    // Recalculate remaining_area if stock_offline changed and product is area-based
    if ("stock_offline" in body && isAreaUnit(primaryUnit)) {
      const calculatedArea = body.calculated_area ?? product.calculated_area;
      if (calculatedArea != null) {
        const totalUsed = stockOffline.reduce((sum, e) => {
          return sum + (e.area_used != null
            ? Number(e.area_used)
            : Number(e.unit_qty?.qty || e.stock || 0));
        }, 0);
        body.remaining_area = Math.max(0, calculatedArea - totalUsed);
        body.area_unit      = primaryUnit;
      }
    }

    // Propagate non-stock edits to clones (name, brand, size, price, etc.)
    // NOTE: product_code / product_codes / batch_id are intentionally excluded —
    // each sibling/clone keeps its own unique code.
    const clones = await ProductSchema.find({ parent_product_id: id }).lean();
    if (!_.isEmpty(clones)) {
      const safeForClones = _.omit(body, [
        "stock_info", "stock_offline", "unit_stock_summary",
        "stock_count", "remaining_area", "allocations",
        "allocation_stats", "product_code", "product_codes", "batch_id",
      ]);
      if (!_.isEmpty(safeForClones)) {
        const cloneIds = clones.map((c) => c._id);
        await ProductSchema.updateMany({ _id: { $in: cloneIds } }, { $set: safeForClones });
      }
    }

    const updated = await ProductSchema.findByIdAndUpdate(id, { $set: body }, { new: true });
    if (!updated) return errorResponse(res, PRODUCT_EDITED_FAILED);

    return successResponse(res, PRODUCT_EDITED_SUCCESS, updated);
  } catch (error) {
    console.error("editProduct error:", error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── STOCK OUT (with area + allocation tracking) ──────────────────────────────
const stockOut = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      qty,
      taken_by      = "",
      customer_details = "",
      job_no        = "",
      handler_name  = "",
      location      = "",
      notes         = "",
      date,
    } = req.body;

    if (!qty || Number(qty) <= 0) {
      return errorResponse(res, "Quantity must be greater than 0");
    }

    const product = await ProductSchema.findById(id);
    if (!product) return errorResponse(res, PRODUCT_GET_FAILED);

    const primaryUnit  = product.primary_unit || "pcs";
    const currentStock = product.stock_count  || 0;
    const removeQty    = Number(qty);

    if (removeQty > currentStock) {
      return errorResponse(res, `Cannot remove ${removeQty} ${primaryUnit} — only ${currentStock} in stock`);
    }

    const outEntry = {
      stock:            removeQty,
      unit_qty:         { qty: removeQty, unit: primaryUnit },
      taken_by,
      customer_details,
      job_no,
      handler_name,
      location,
      notes,
      date: date ? new Date(date) : new Date(),
      area_used:        null,
      remaining_area:   null,
      area_unit:        null,
    };

    let newRemainingArea = product.remaining_area;
    if (isAreaUnit(primaryUnit) && product.calculated_area != null) {
      const currentRemaining = product.remaining_area ?? product.calculated_area;
      const areaUsed         = removeQty;
      if (areaUsed > currentRemaining) {
        return errorResponse(res, `Not enough area — only ${currentRemaining.toFixed(2)} ${primaryUnit} remaining`);
      }
      newRemainingArea          = Math.max(0, currentRemaining - areaUsed);
      outEntry.area_used        = areaUsed;
      outEntry.remaining_area   = newRemainingArea;
      outEntry.area_unit        = primaryUnit;
    }

    const allocationEntry = {
      allocated_at:         outEntry.date,
      allocated_by:         handler_name,
      allocated_to:         taken_by || customer_details,
      job_no,
      alloc_unit_qty:       { qty: removeQty, unit: primaryUnit },
      area_consumed:        outEntry.area_used,
      area_unit:            outEntry.area_unit,
      remaining_area_after: newRemainingArea,
      status:               "allocated",
      notes,
    };

    const updatedStockOffline = [...(product.stock_offline || []), outEntry];
    const updatedStockInfo    = product.stock_info || [];
    const newSummary          = buildUnitSummary(updatedStockInfo, updatedStockOffline, primaryUnit);
    const primarySummary      = newSummary.find((s) => s.unit === primaryUnit);
    const newStockCount       = primarySummary ? primarySummary.net_stock : currentStock - removeQty;

    const allAllocations = [...(product.allocations || []), allocationEntry];
    const areaStats = isAreaUnit(primaryUnit) ? {
      total_allocated_area: allAllocations.reduce((s, a) => s + (a.area_consumed || 0), 0),
      total_returned_area:  allAllocations.filter((a) => a.status === "returned" || a.status === "partial_return")
                              .reduce((s, a) => s + (a.returned_qty || 0), 0),
    } : {};

    const allocationStats = {
      total_allocated_qty:  allAllocations.reduce((s, a) => s + (a.alloc_unit_qty?.qty || 0), 0),
      total_returned_qty:   allAllocations.filter((a) => a.returned_qty != null)
                              .reduce((s, a) => s + (a.returned_qty || 0), 0),
      total_consumed_qty:   allAllocations.filter((a) => a.status === "consumed")
                              .reduce((s, a) => s + (a.alloc_unit_qty?.qty || 0), 0),
      allocation_count:     allAllocations.length,
      stats_unit:           primaryUnit,
      ...areaStats,
    };

    const updated = await ProductSchema.findByIdAndUpdate(
      id,
      {
        $set: {
          stock_offline:      updatedStockOffline,
          unit_stock_summary: newSummary,
          stock_count:        Math.max(0, newStockCount),
          stocks_status:      Math.max(0, newStockCount) === 0 ? "Out of Stock"
                              : Math.max(0, newStockCount) <= 10 ? "Limited" : "In Stock",
          remaining_area:     newRemainingArea,
          allocations:        allAllocations,
          allocation_stats:   allocationStats,
        },
      },
      { new: true }
    );

    return successResponse(res, PRODUCT_EDITED_SUCCESS, updated);
  } catch (error) {
    console.error("stockOut error:", error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── RETURN ALLOCATION ────────────────────────────────────────────────────────
const returnAllocation = async (req, res) => {
  try {
    const { id } = req.params;
    const { allocation_id, returned_qty, return_notes = "" } = req.body;

    if (!allocation_id || !returned_qty || Number(returned_qty) <= 0) {
      return errorResponse(res, "allocation_id and returned_qty are required");
    }

    const product = await ProductSchema.findById(id);
    if (!product) return errorResponse(res, PRODUCT_GET_FAILED);

    const primaryUnit = product.primary_unit || "pcs";
    const allocIdx    = product.allocations.findIndex(
      (a) => a._id.toString() === allocation_id
    );
    if (allocIdx === -1) {
      return errorResponse(res, "Allocation record not found");
    }

    const alloc      = product.allocations[allocIdx];
    const retQty     = Number(returned_qty);
    const prevReturn = alloc.returned_qty || 0;
    const maxReturn  = (alloc.alloc_unit_qty?.qty || 0) - prevReturn;

    if (retQty > maxReturn) {
      return errorResponse(res, `Cannot return more than ${maxReturn} ${primaryUnit}`);
    }

    const newReturnTotal = prevReturn + retQty;
    const newStatus      = newReturnTotal >= (alloc.alloc_unit_qty?.qty || 0)
      ? "returned"
      : "partial_return";

    product.allocations[allocIdx].returned_qty  = newReturnTotal;
    product.allocations[allocIdx].returned_at   = new Date();
    product.allocations[allocIdx].return_notes  = return_notes;
    product.allocations[allocIdx].status        = newStatus;

    const returnStockEntry = {
      add_stock:    retQty,
      unit_qty:     { qty: retQty, unit: primaryUnit },
      handler_name: "Return",
      notes:        `Return of allocation ${allocation_id}. ${return_notes}`,
      date:         new Date(),
    };
    product.stock_info.push(returnStockEntry);

    const newSummary = buildUnitSummary(product.stock_info, product.stock_offline, primaryUnit);
    const primarySum = newSummary.find((s) => s.unit === primaryUnit);
    const newCount   = primarySum ? primarySum.net_stock : 0;

    let newRemainingArea = product.remaining_area;
    if (isAreaUnit(primaryUnit) && product.calculated_area != null) {
      newRemainingArea = Math.min(
        product.calculated_area,
        (product.remaining_area || 0) + retQty
      );
    }

    const allAllocations = product.allocations;
    const areaStats = isAreaUnit(primaryUnit) ? {
      total_allocated_area: allAllocations.reduce((s, a) => s + (a.area_consumed || 0), 0),
      total_returned_area:  allAllocations
        .filter((a) => a.returned_qty != null)
        .reduce((s, a) => s + (a.returned_qty || 0), 0),
    } : {};

    const allocationStats = {
      total_allocated_qty: allAllocations.reduce((s, a) => s + (a.alloc_unit_qty?.qty || 0), 0),
      total_returned_qty:  allAllocations
        .filter((a) => a.returned_qty != null)
        .reduce((s, a) => s + (a.returned_qty || 0), 0),
      total_consumed_qty:  allAllocations
        .filter((a) => a.status === "consumed")
        .reduce((s, a) => s + (a.alloc_unit_qty?.qty || 0), 0),
      allocation_count:    allAllocations.length,
      stats_unit:          primaryUnit,
      ...areaStats,
    };

    await ProductSchema.findByIdAndUpdate(id, {
      $set: {
        allocations:        product.allocations,
        stock_info:         product.stock_info,
        unit_stock_summary: newSummary,
        stock_count:        Math.max(0, newCount),
        stocks_status:      Math.max(0, newCount) === 0 ? "Out of Stock"
                            : Math.max(0, newCount) <= 10 ? "Limited" : "In Stock",
        remaining_area:     newRemainingArea,
        allocation_stats:   allocationStats,
      },
    });

    return successResponse(res, PRODUCT_EDITED_SUCCESS, { allocation_id, newStatus, newRemainingArea });
  } catch (error) {
    console.error("returnAllocation error:", error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── GET BATCH (all products sharing a batch_id) ──────────────────────────────
const getBatch = async (req, res) => {
  try {
    const { batch_id } = req.params;
    if (!batch_id) return errorResponse(res, "batch_id is required");

    const products = await ProductSchema.find({ batch_id }).lean();
    if (!products.length) return errorResponse(res, "No products found for this batch");

    const annotated = products.map((p) => ({
      ...p,
      _area_summary: isAreaUnit(p.primary_unit)
        ? {
            calculated_area: p.calculated_area,
            remaining_area:  p.remaining_area,
            used_area:       (p.calculated_area || 0) - (p.remaining_area || 0),
            area_unit:       p.area_unit || p.primary_unit,
            pct_used:        p.calculated_area
              ? (((p.calculated_area - (p.remaining_area || 0)) / p.calculated_area) * 100).toFixed(1)
              : 0,
          }
        : null,
    }));

    return successResponse(res, PRODUCT_GET_SUCCESS, annotated);
  } catch (error) {
    console.error("getBatch error:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── DELETE PRODUCT ───────────────────────────────────────────────────────────

const deleteProduct = async (req, res) => {
  try {
    const { product_id, is_cloned } = JSON.parse(req.params.id);
    if (!is_cloned) {
      await ProductSchema.deleteMany({ parent_product_id: product_id });
    }
    await ProductSchema.findByIdAndDelete(product_id);
    return successResponse(res, PRODUCT_DELETED_SUCCESS);
  } catch (error) {
    console.error("deleteProduct error:", error);
    return errorResponse(res, PRODUCT_DELETED_FAILED);
  }
};

module.exports = {
  addProduct,
  previewCodes,
  getProduct,
  editProduct,
  deleteProduct,
  stockOut,
  returnAllocation,
  getBatch,
};