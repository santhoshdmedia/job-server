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

// ─── Helper: Normalise size ───────────────────────────────────────────────────
// ✅ FIX: Accepts { width, width_unit, height, height_unit } from frontend.
//         Drops the object entirely if both dimensions are empty/null.
const normaliseSize = (size) => {
  if (!size) return null;

  const { width, height } = size;
  const hasAnyDimension =
    (width  !== null && width  !== undefined && width  !== "") ||
    (height !== null && height !== undefined && height !== "");

  if (!hasAnyDimension) return null;

  return {
    width:       width  !== "" && width  !== undefined ? Number(width)  : null,
    width_unit:  size.width_unit  || "feet",
    height:      height !== "" && height !== undefined ? Number(height) : null,
    height_unit: size.height_unit || "feet",
    // legacy field — set to width_unit so old reads don't break
    unit:        size.width_unit  || "feet",
  };
};

// ─── Add Product ──────────────────────────────────────────────────────────────
const addProduct = async (req, res) => {
  try {
    req.body.size = normaliseSize(req.body.size);
    const result = await ProductSchema.create(req.body);
    return successResponse(res, PRODUCT_ADDED_SUCCESS, result);
  } catch (error) {
    console.error("addProduct error:", error);
    return errorResponse(res, PRODUCT_ADDED_FAILED);
  }
};

// ─── Get Products ─────────────────────────────────────────────────────────────
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
  } = req.query;

  const { id } = req.params;

  try {
    const where = {};

    if (id_list) {
      const list = JSON.parse(id_list);
      where.seo_url = { $in: list };
    }

    if (filterByType)                 where.type                 = filterByType;
    if (filterByProduct_category)     where.category_details     = new ObjectId(filterByProduct_category);
    if (filterByProduct_subcategory)  where.sub_category_details = new ObjectId(filterByProduct_subcategory);
    if (vendor_filter)                where.vendor_details       = new ObjectId(vendor_filter);

    if (visibility === "true")        where.is_visible = true;
    else if (visibility === "false")  where.is_visible = false;

    if (search) {
      where.$or = [
        { name:             { $regex: search, $options: "i" } },
        { product_codeS_NO: { $regex: search, $options: "i" } },
        { Vendor_Code:      { $regex: search, $options: "i" } },
      ];
    }

    if (material_brand) {
      where.material_brand = { $regex: material_brand, $options: "i" };
    }

    // ✅ FIX: match against width_unit OR legacy unit field
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

    const result = await ProductSchema.find(where);
    return successResponse(res, PRODUCT_GET_SUCCESS, result);
  } catch (error) {
    console.error("getProduct error:", error);
    return errorResponse(res, PRODUCT_GET_FAILED);
  }
};

// ─── Edit Product ─────────────────────────────────────────────────────────────
const editProduct = async (req, res) => {
  try {
    const { id } = req.params;

    if ("size" in req.body) {
      req.body.size = normaliseSize(req.body.size);
    }

    const clones = await ProductSchema.find({ parent_product_id: id });
    if (!_.isEmpty(clones)) {
      const cloneIds = clones.map((c) => c._id);
      await ProductSchema.updateMany({ _id: { $in: cloneIds } }, req.body);
    }

    const updated = await ProductSchema.findByIdAndUpdate(id, req.body, { new: true });
    if (!updated) return errorResponse(res, PRODUCT_EDITED_FAILED);

    return successResponse(res, PRODUCT_EDITED_SUCCESS, updated);
  } catch (error) {
    console.error("editProduct error:", error);
    return errorResponse(res, PRODUCT_EDITED_FAILED);
  }
};

// ─── Delete Product ───────────────────────────────────────────────────────────
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

module.exports = { addProduct, getProduct, editProduct, deleteProduct };