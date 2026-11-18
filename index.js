import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { connectDB } from "./db.js";
import { notFound, errorHandler } from "./middleware/errorHandler.js";
import { sendResponse } from "./helpers.js";

import publicRoutes from "./routes/public.js";
import usersRoutes from "./routes/users.js";
import servicesRoutes from "./routes/services.js";
import vendorRoutes from "./routes/vendor.js";
import customerRoutes from "./routes/customer.js";
import bookingsRoutes from "./routes/bookings.js";
import adminRoutes from "./routes/admin.js";
import paymentsRoutes from "./routes/payments.js";
import webhookRoutes from "./routes/webhooks.js";

const app = express();
app.use(helmet());

const allowedOrigins = (process.env.CLIENT_URL || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.options(/.*/, cors());

app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }), webhookRoutes);

app.use(express.json({ limit: "1mb" }));
app.get("/", (req, res) => {
  sendResponse(res, 200, true, "WedMera API is running.");
});
app.get("/api/health", (req, res) => {
  sendResponse(res, 200, true, "WedMera API is healthy.", { status: "ok" });
});

const ensureDB = async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    next(error);
  }
};

app.use("/api/webhooks/stripe", ensureDB);
app.use("/api", publicRoutes);
app.use("/api/users", ensureDB, usersRoutes);
app.use("/api/services", ensureDB, servicesRoutes);
app.use("/api/vendor", ensureDB, vendorRoutes);
app.use("/api/customer", ensureDB, customerRoutes);
app.use("/api/bookings", ensureDB, bookingsRoutes);
app.use("/api/admin", ensureDB, adminRoutes);
app.use("/api/payments", ensureDB, paymentsRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`WedMera API is running on port ${port}.`);
  });
}
