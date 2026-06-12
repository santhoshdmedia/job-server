const express = require("express");
const router  = express.Router();

const {
  addProduct,
  previewCodes,
  getProduct,
  editProduct,
  deleteProduct,
  stockOut,
  returnAllocation,
  getBatch,
} = require("../controller/product.controller");



// ── Code preview (server-driven, no sequence consumed) ─────────────────────
// Called by the frontend's "Auto Codes" preview, debounced on every keystroke.
router.post("/preview-codes", previewCodes);
 
// ── Create product(s) — reserves sequence + creates batch ──────────────────
router.post("/add_product", addProduct);
 
// ── Read ─────────────────────────────────────────────────────────────────
router.get("/batch/:batch_id", getBatch);
router.get("/get_product", getProduct);
router.get("/get_product/:id", getProduct);
 
// ── Update ───────────────────────────────────────────────────────────────
router.put("/edit_product/:id", editProduct);
router.patch("/edit_product/:id", editProduct);
 
// ── Stock movements ─────────────────────────────────────────────────────
router.post("/stock-out/:id", stockOut);
router.post("/return-allocation/:id", returnAllocation);
 
// ── Delete ───────────────────────────────────────────────────────────────
router.delete("/delete_product/:id", deleteProduct);
 
module.exports = router;