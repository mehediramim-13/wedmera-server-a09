import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { connectDB, initDatabase } from "./db.js";
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

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS."));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  // A failed preflight is indistinguishable from a missing token in the
  // browser, so answer OPTIONS explicitly and cache the result.
  preflightContinue: false,
  optionsSuccessStatus: 204,
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// If the client calls a path without the "/api" prefix (for example
// /vendor/subscription), add the prefix so it reaches the same routes.
app.use((req, res, next) => {
  if (req.url === "/" || /^\/api(\/|\?|$)/.test(req.url)) return next();
  req.url = `/api${req.url}`;
  next();
});

const ensureDB = async (req, res, next) => {
  try {
    await connectDB();
    await initDatabase();
    next();
  } catch (error) {
    console.error("MongoDB request initialization failed:", error.message);
    next(error);
  }
};

// Stripe signature verification needs the exact raw request bytes. Mount the
// webhook route before express.json() so the body is not parsed first.
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }), ensureDB, webhookRoutes);

app.use(express.json({ limit: "1mb" }));
app.get("/", (req, res) => {
  sendResponse(res, 200, true, "WedMera API is running.");
});
app.get("/api/health", (req, res) => {
  sendResponse(res, 200, true, "WedMera API is healthy.", { status: "ok" });
});
app.get("/api/health/db", async (req, res) => {
  try {
    const db = await initDatabase();
    await db.command({ ping: 1 });
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    res.json({
      success: true,
      database: process.env.DB_NAME,
      collections: collections.map((collection) => collection.name),
    });
  } catch (error) {
    console.error("MongoDB health check failed:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.use("/api", ensureDB);
// Mount the private service-details router before the public router so
// /api/services/:id can never be shadowed by a public /api/services route.
app.use("/api/services", servicesRoutes);
app.use("/api", publicRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api/customer", customerRoutes);
app.use("/api/bookings", bookingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentsRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;

if (!process.env.VERCEL) {
  const startServer = async () => {
    try {
      await initDatabase();
      const businessCollections = ["services", "bookings", "transactions"];
      console.log(`MongoDB connected: ${process.env.DB_NAME}`);
      console.log(`Collections ready: ${businessCollections.join(", ")}`);
      const port = process.env.PORT || 5000;
      app.listen(port, () => {
        console.log(`WedMera API is running on port ${port}.`);
      });
    } catch (error) {
      console.error("Unable to start WedMera API:", error.message);
      process.exitCode = 1;
    }
  };
  startServer();
}