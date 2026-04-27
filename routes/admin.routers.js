const {getAdmin,addAdmin,deleteAdmin,updateAdmin} = require("./controller_import");
const router = require("express").Router();
const {VerfiyToken} = require("../helper/shared.helper")


router.get("/get_admin",getAdmin);
router.post("/add_admin",VerfiyToken,addAdmin);
router.put("/update_admin/:id",VerfiyToken,updateAdmin);
router.delete("/delete_admin/:id",VerfiyToken,deleteAdmin);

module.exports = router;