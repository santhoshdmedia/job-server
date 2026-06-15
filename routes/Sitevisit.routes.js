const express = require("express");
const router  = express.Router();
const {
  createSiteVisit,
  getAllSiteVisits,
  getVisitsByUser,
  getSiteVisit,
  updateSiteVisit,
  deleteSiteVisit,
  startSession,
  closeSession,
  getSessionStatus,
  inviteMember,
  removeMember,
  addMeasurement,
  updateMeasurements,
  deleteMeasurement,
  addPhotos,
  deletePhoto,
  saveSheet,
  convertToJob,
} = require("../controller/Sitevisit.controller");

// ── CRUD ────────────────────────────────────────────────────────────────────
router.post  ("/",              createSiteVisit);
router.get   ("/",              getAllSiteVisits);
router.get   ("/user/:userId",  getVisitsByUser);
router.get   ("/:id",          getSiteVisit);
router.put   ("/:id",          updateSiteVisit);
router.delete("/:id",          deleteSiteVisit);

// ── Session ─────────────────────────────────────────────────────────────────
router.post("/:id/session/start",   startSession);
router.post("/:id/session/close",   closeSession);
router.get ("/:id/session/status",  getSessionStatus);

// ── Team members ─────────────────────────────────────────────────────────────
router.post  ("/:id/members",            inviteMember);
router.delete("/:id/members/:memberId",  removeMember);

// ── Measurements ─────────────────────────────────────────────────────────────
router.post  ("/:id/measurements",                    addMeasurement);
router.put   ("/:id/measurements",                    updateMeasurements);
router.delete("/:id/measurements/:measurementId",     deleteMeasurement);

// ── Photos ───────────────────────────────────────────────────────────────────
router.post  ("/:id/photos",          addPhotos);
router.delete("/:id/photos/:photoId", deletePhoto);

// ── Sheet (observations / recommendation) ────────────────────────────────────
router.patch("/:id/sheet",   saveSheet);

// ── Convert ──────────────────────────────────────────────────────────────────
router.patch("/:id/convert", convertToJob);

module.exports = router;

/*
 * ── HOW TO MOUNT IN YOUR EXPRESS APP ───────────────────────────────────────
 *
 *   const siteVisitRoutes = require("./routes/siteVisit.routes");
 *   app.use("/api/site-visits", siteVisitRoutes);
 *
 * ── QUICK REFERENCE ─────────────────────────────────────────────────────────
 *   POST   /api/site-visits                        create
 *   GET    /api/site-visits                        list all  (admin)
 *   GET    /api/site-visits/user/:userId           my visits
 *   GET    /api/site-visits/:id                    single
 *   PUT    /api/site-visits/:id                    update info
 *   DELETE /api/site-visits/:id                    delete
 *
 *   POST   /api/site-visits/:id/session/start      start / resume timer
 *   POST   /api/site-visits/:id/session/close      pause / complete timer
 *   GET    /api/site-visits/:id/session/status     timer status
 *
 *   POST   /api/site-visits/:id/members            invite team member
 *   DELETE /api/site-visits/:id/members/:memberId  remove member
 *
 *   POST   /api/site-visits/:id/measurements       add one measurement
 *   PUT    /api/site-visits/:id/measurements       replace all measurements
 *   DELETE /api/site-visits/:id/measurements/:mid  remove one
 *
 *   POST   /api/site-visits/:id/photos             add photos [{url,caption,gps}]
 *   DELETE /api/site-visits/:id/photos/:photoId    remove one photo
 *
 *   PATCH  /api/site-visits/:id/sheet              save observations+recommendation
 *   PATCH  /api/site-visits/:id/convert            mark converted to job
 */