
const {
  login,
  changePasswrod,
  checkloginstatus,
} = require("../controller/auth.controller");


const {
  addAdmin,
  getAdmin,
  deleteAdmin,
  updateAdmin,
} = require("../controller/admin.controller");
const {
  clientLogin,
  clientgoogleLogin,
  clientSignup,
  getAllCustomUsers,
  customSignup,
  clientCheckloginstatus,
  getAllClientUsers,
  updateClientUser,
  deleteClientUser,
  getSingleClient,
  addtoHistory,
  BNISignup
} = require("../controller/user.controller");



const {
  sendForgetPasswordMail,
  resetPassword,
  verfiyLink,
  sendDealerPasswordMail
} = require("../controller/mail.controller");





module.exports = {
  login,
  changePasswrod,
  checkloginstatus,
  //admin users
  addAdmin,
  getAdmin,
  deleteAdmin,
  updateAdmin,

  // user
  clientLogin,
  clientSignup,
  clientCheckloginstatus,
  getAllClientUsers,
  deleteClientUser,
  updateClientUser,
  getSingleClient,
  addtoHistory,
  clientgoogleLogin,

  // bni
  BNISignup,
  // custom user
  customSignup,
  getAllCustomUsers,

  // mail
  sendForgetPasswordMail,
  sendDealerPasswordMail,
  verfiyLink,
  resetPassword,


};
