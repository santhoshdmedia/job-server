const router = require("express").Router();

const { UploadImage} = require("../controller/shared.controller");

const { upload } = require("../helper/multer.helper");


const { VerfiyToken } = require("../helper/shared.helper");


const { auth_routes, admin_routers,job_routers,product_routers,staff_routers,meterial_routers,Inforequest_routes,visit_routers } = require("../routes/routes_import");
// const { route } = require("./mail.routes");
    ``
router.use("/auth", auth_routes);
router.use("/admin", admin_routers);
router.use("/jobs", job_routers);
router.post("/upload_images", upload.single("image"), UploadImage);
router.use("/product", product_routers);
router.use("/staff", staff_routers);
router.use("/material", meterial_routers);
router.use("/info-requests", Inforequest_routes);
router.use("/site-visits", visit_routers);
// router.use("/quotation", QuotationRoutes);
// pdf export
module.exports = router;
