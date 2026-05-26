// ==================== PRODUCT CONTROLLER ====================
// Handles: addProduct, getProduct, editProduct, deleteProduct
// Updated: getProduct now supports filtering by material_brand and size.unit
// All other behaviour is preserved from the previous version.

const { ProductSchema, UserSchema } = require("./models_import");
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

// ─── Add Product ──────────────────────────────────────────────────────────────
// POST /api/products
// Body: full product payload from NewProductStockModal.
//
// The request body may contain:
//   material_brand : string  (e.g. "3M")
//   size           : { width: number|null, height: number|null, unit: string }
//                    OR null / omitted → stored as null in DB.
//
// Both fields are passed straight through to ProductSchema.create() because
// Mongoose validates them against the schema before saving.

const addProduct = async (req, res) => {
  try {
    // Normalise size: if the client sends an empty-ish size object
    // (both width and height are null / undefined) treat it as null.
    if (req.body.size) {
      const { width, height } = req.body.size;
      const hasAnyDimension =
        (width  !== null && width  !== undefined && width  !== "") ||
        (height !== null && height !== undefined && height !== "");

      if (!hasAnyDimension) {
        req.body.size = null;
      }
    }

    const result = await ProductSchema.create(req.body);
    return successResponse(res, PRODUCT_ADDED_SUCCESS, result);
  } catch (error) {
    console.error("addProduct error:", error);
    return errorResponse(res, PRODUCT_ADDED_FAILED);
  }
};

// ─── Get Products ─────────────────────────────────────────────────────────────
// GET /api/products/:id?   (id = seo_url, optional)
// Query params:
//   search                   — name | product_codeS_NO | Vendor_Code (regex, case-insensitive)
//   filterByProduct_category — ObjectId string
//   filterByProduct_subcategory — ObjectId string
//   filterByType             — "Stand Alone Product" | "Variable Product" | "Variant Product"
//   vendor_filter            — ObjectId string
//   visibility               — "true" | "false" | "" (all)
//   isAdmin                  — boolean string
//   id_list                  — JSON array of seo_url strings (cart/wishlist lookup)
//
//   NEW PARAMS:
//   material_brand           — exact or partial brand search (regex, case-insensitive)
//   size_unit                — exact match on size.unit ("inches"|"feet"|"cm"|"meters"|"mm")

const getProduct = async (req, res) => {
  const {
    filterByProduct_category    = "",
    filterByType                = "",
    filterByProduct_subcategory = "",
    search                      = "",
    vendor_filter               = "",
    isAdmin                     = false,
    id_list,
    visibility                  = "",
    // ── NEW filter params ───────────────────────────────────────────────────
    material_brand              = "",
    size_unit                   = "",
  } = req.query;

  const { id } = req.params; // seo_url — optional

  try {
    const where = {};

    // ── id_list (cart / wishlist lookup by array of seo_url values) ───────
    if (id_list) {
      const list = JSON.parse(id_list);
      where.seo_url = { $in: list };
    }

    // ── Standard filters ──────────────────────────────────────────────────
    if (filterByType)                 where.type                 = filterByType;
    if (filterByProduct_category)     where.category_details     = new ObjectId(filterByProduct_category);
    if (filterByProduct_subcategory)  where.sub_category_details = new ObjectId(filterByProduct_subcategory);
    if (vendor_filter)                where.vendor_details       = new ObjectId(vendor_filter);

    // ── Visibility filter ─────────────────────────────────────────────────
    if (visibility === "true")        where.is_visible = true;
    else if (visibility === "false")  where.is_visible = false;

    // ── Full-text search across name, product code, vendor code ───────────
    if (search) {
      where.$or = [
        { name:             { $regex: search, $options: "i" } },
        { product_codeS_NO: { $regex: search, $options: "i" } },
        { Vendor_Code:      { $regex: search, $options: "i" } },
      ];
    }

    // ── NEW: Material Brand filter ─────────────────────────────────────────
    // Partial, case-insensitive match so "3M" finds "3M Premium" too.
    if (material_brand) {
      where.material_brand = { $regex: material_brand, $options: "i" };
    }

    // ── NEW: Size unit filter ─────────────────────────────────────────────
    // Exact match on the measurement unit stored in size.unit.
    if (size_unit) {
      where["size.unit"] = size_unit;
    }

    // ── Single product lookup by seo_url ──────────────────────────────────
    if (id) {
      where.seo_url = id;
    }

    const result = await ProductSchema.find(where);

    return successResponse(res, PRODUCT_GET_SUCCESS, result);
  } catch (error) {
    console.error("getProduct error:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── Edit Product ─────────────────────────────────────────────────────────────
// PUT /api/products/:id
// Body: partial or full product fields to update.
//
// Supported update scenarios (from frontend):
//   StockInModal     → { stock_info, unit_stock_summary, stock_count }
//   StockOutModal    → { stock_offline, unit_stock_summary, stock_count }
//   handleOnChangeLabel → { is_visible }
//   EditProductModal → any field including material_brand and size
//
// SIZE normalisation is applied here too so that editing a product and
// clearing both width & height correctly stores null instead of an empty object.

const editProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // Normalise size before saving (same logic as addProduct)
    if (req.body.size) {
      const { width, height } = req.body.size;
      const hasAnyDimension =
        (width  !== null && width  !== undefined && width  !== "") ||
        (height !== null && height !== undefined && height !== "");

      if (!hasAnyDimension) {
        req.body.size = null;
      }
    }

    // Propagate edits to any cloned children of this product
    const clones = await ProductSchema.find({ parent_product_id: id });
    if (!_.isEmpty(clones)) {
      const cloneIds = clones.map((c) => c._id);
      await ProductSchema.updateMany({ _id: { $in: cloneIds } }, req.body);
    }

    const updated = await ProductSchema.findByIdAndUpdate(id, req.body, { new: true });

    if (!updated) {
      // Product not found — still return a structured error rather than crashing
      return errorResponse(res, PRODUCT_EDITED_FAILED);
    }

    return successResponse(res, PRODUCT_EDITED_SUCCESS, updated);
  } catch (error) {
    console.error("editProduct error:", error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── Delete Product ───────────────────────────────────────────────────────────
// DELETE /api/products/:id
// Param id must be a JSON-encoded string: JSON.stringify({ product_id, is_cloned })
// Deletes cloned children first when removing an original product.

const deleteProduct = async (req, res) => {
  try {
    const { product_id, is_cloned } = JSON.parse(req.params.id);

    // Remove cloned children only when deleting the original
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  addProduct,
  getProduct,
  editProduct,
  deleteProduct,
};