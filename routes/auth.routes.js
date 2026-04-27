const { VerfiyToken } = require("../helper/shared.helper");
const { login, changePasswrod, checkloginstatus } = require("../routes/controller_import");
const router = require("express").Router();

router.post("/login", login);
router.post("/change_password", VerfiyToken, changePasswrod);
router.get("/check_login", VerfiyToken, checkloginstatus);

module.exports = router;
