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
// Used by: NewProductStockModal → addproduct()

const addProduct = async (req, res) => {
  try {
    const result = await ProductSchema.create(req.body);
    return successResponse(res, PRODUCT_ADDED_SUCCESS, result);
  } catch (error) {
    console.error(error);
    return errorResponse(res, PRODUCT_ADDED_FAILED);
  }
};

// ─── Get Products ─────────────────────────────────────────────────────────────
// Used by: fetchData() → getProduct(id, search, isAdmin, category, type, subcategory, vendor, visibility)
// Filters active: filterByProduct_category, filterByType, filterByProduct_subcategory,
//                 vendor_filter, id (seo_url), search (name | product_codeS_NO | Vendor_Code),
//                 is_visible (visibilityFilter)

const getProduct = async (req, res) => {
  const {
    filterByProduct_category = "",
    filterByType = "",
    filterByProduct_subcategory = "",
    search,
    vendor_filter,
    isAdmin = false,
    id_list,
    // visibility passed as string "true" | "false" | ""
    visibility = "",
  } = req.query;
  const { id } = req.params; // seo_url

  try {
    const where = {};

    // ── id_list (cart / wishlist lookup by seo_url array) ──────────────────
    if (id_list) {
      const list = JSON.parse(id_list);
      where.seo_url = { $in: list };
    }

    // ── Basic filters ──────────────────────────────────────────────────────
    if (filterByType)                 where.type                = filterByType;
    if (filterByProduct_category)     where.category_details    = new ObjectId(filterByProduct_category);
    if (filterByProduct_subcategory)  where.sub_category_details = new ObjectId(filterByProduct_subcategory);
    if (vendor_filter)                where.vendor_details      = new ObjectId(vendor_filter);

    // ── Visibility filter ──────────────────────────────────────────────────
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

    // ── Single product by seo_url ──────────────────────────────────────────
    if (id) {
      where.seo_url = id;
    }

    const result = await ProductSchema.find(where)

    return successResponse(res, PRODUCT_GET_SUCCESS, result);
  } catch (error) {
    console.error("Error in getProduct:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── Edit Product ─────────────────────────────────────────────────────────────
// Used by:
//   • StockInModal  → editProduct({ stock_info, stock_count }, id)
//   • StockOutModal → editProduct({ stock_offline, stock_count }, id)
//   • handleOnChangeLabel → editProduct({ is_visible }, id)

const editProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // Propagate edits to any cloned children
    const clones = await ProductSchema.find({ parent_product_id: id });
    if (!_.isEmpty(clones)) {
      const cloneIds = clones.map((c) => c._id);
      await ProductSchema.updateMany({ _id: { $in: cloneIds } }, req.body);
    }

    await ProductSchema.findByIdAndUpdate(id, req.body, { new: true });

    return successResponse(res, PRODUCT_EDITED_SUCCESS);
  } catch (error) {
    console.error(error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── Delete Product ───────────────────────────────────────────────────────────
// Used by: (delete button — hasDeletePermission guard on frontend)
// Payload: JSON-encoded { product_id, is_cloned } in req.params.id

const deleteProduct = async (req, res) => {
  const { product_id, is_cloned } = JSON.parse(req.params.id);
  try {
    // Delete cloned children only when removing the original
    if (!is_cloned) {
      await ProductSchema.deleteMany({ parent_product_id: product_id });
    }
    await ProductSchema.findByIdAndDelete(product_id);

    return successResponse(res, PRODUCT_DELETED_SUCCESS);
  } catch (error) {
    console.error(error);
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


