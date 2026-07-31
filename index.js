const express = require("express");
const router = require("./routes");
const cors = require("cors");
const mongoose = require("mongoose");
require("dotenv").config();
const morgan = require("morgan");



const app = express();

app.set("trust proxy", 1);
app.use(morgan("dev"));

app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ limit: "500mb", extended: true }));

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: "*",
  maxAge: 86400,
}));


// ==================== HEALTH CHECK ====================

app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ==================== API ROUTES ====================


app.use("/api", router);
// Add this AFTER all routes, before app.listen
app.use((err, req, res, next) => {
  console.error("Global error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// ==================== START ====================

const Port = process.env.PORT || 8000;
const Host = process.env.HOST || "0.0.0.0";

mongoose.connect(process.env.MONGODB_URI).then(() => {
  app.listen(Port, Host, () => {
    const localIp = require("os").networkInterfaces()["eth0"]?.[0]?.address ||
                    require("os").networkInterfaces()["wlan0"]?.[0]?.address;
    console.log(`🚀 Server on http://${localIp || Host}:${Port}`);
  });

});