const router = require("express").Router();
const { addProduct, getProduct, deleteProduct, editProduct, getProductVariantPrice, getHistoryProducts, getBannerProducts, addProductDescription, getProductDescription, updateProductDescription, deleteProductDescription,getAllProductsSimple } = require("../controller/product.controller");
const { VerfiyToken } = require("../helper/shared.helper");

router.post("/add_product", VerfiyToken, addProduct);
router.get('/get_product',     getProduct);  
router.get('/get_product/:id', getProduct);  
router.put("/edit_product/:id", VerfiyToken, editProduct);
router.delete("/delete_product/:id", VerfiyToken, deleteProduct);


module.exports = router;
