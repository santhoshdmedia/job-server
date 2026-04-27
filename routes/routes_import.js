const auth_routes = require("./auth.routes");
const admin_routers = require("./admin.routers");
const job_routers = require("./job.route");
const product_routers = require("./product.routers");
const staff_routers = require("./staff.route");
const meterial_routers = require("./Material_issue.route");
// const user_routers = require("./user.routers");
// const product_routers = require("./product.routers");





module.exports = {
  auth_routes,
  admin_routers,
  job_routers,
  product_routers,
  staff_routers,
  meterial_routers

  // user_routers,
  // product_routers
};
