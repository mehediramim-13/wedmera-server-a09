import { Router } from "express";
import Stripe from "stripe";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { validateBody } from "../middleware/validate.js";
import { countActiveServices, getFreePlanServiceLimit, getEffectivePlan, isValidObjectId, sendResponse, SERVICE_CATEGORIES, subscriptionResponse, toIsoOrNull, toObjectId, vendorIdQuery } from "../helpers.js";

const router = Router();
router.use(requireAuth, requireRole("vendor"));

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing required environment variable: STRIPE_SECRET_KEY");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

router.get("/overview", async (req, res, next) => {
  try {
    const db = getDb();
    const [totalServices, activeServicesCount, pendingBookingRequests, acceptedBookings] = await Promise.all([
      db.collection("services").countDocuments({ vendorId: vendorIdQuery(req.user._id) }),
      countActiveServices(db, req.user._id),
      db.collection("bookings").countDocuments({ vendorId: req.user._id, status: "Pending" }),
      db.collection("bookings").countDocuments({ vendorId: req.user._id, status: "Accepted" }),
    ]);
    sendResponse(res, 200, true, "Vendor overview fetched.", {
      totalServices,
      activeServices: activeServicesCount,
      activeServicesCount,
      pendingBookingRequests,
      acceptedBookings,
      ...subscriptionResponse(req.user),
    });
  } catch (error) { next(error); }
});

router.get("/services", async (req, res, next) => {
  try {
    const items = await getDb().collection("services").find({ vendorId: vendorIdQuery(req.user._id) }).sort({ createdAt: -1 }).toArray();
    const subscription = subscriptionResponse(req.user);
    sendResponse(res, 200, true, "Vendor services fetched.",
      items.map((item) => ({
        ...item,
        // Legacy services have no isActive field; expose them as active so the
        // plans page and vendor UI agree with the server-side count.
        isActive: item.isActive !== false,
        isPremium: subscription.plan === "premium",
        subscriptionPlan: subscription.plan,
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      })));
  } catch (error) { next(error); }
});

const createServiceSchema = z.object({
  serviceName: z.string().trim().min(3).max(120),
  category: z.enum(SERVICE_CATEGORIES),
  description: z.string().trim().min(10).max(2000),
  price: z.coerce.number().positive(),
  location: z.string().trim().min(2).max(200),
  images: z.array(z.string().url().refine((url) => ["http:", "https:"].includes(new URL(url).protocol))).min(1).max(5),
}).strict();

router.post("/services", validateBody(createServiceSchema), async (req, res, next) => {
  try {
    const db = getDb();
    if (getEffectivePlan(req.user) === "free") {
      const count = await countActiveServices(db, req.user._id);
      const limit = getFreePlanServiceLimit();
      if (count >= limit) {
        return sendResponse(res, 403, false, `Free plan limit reached (${limit} active services). Upgrade to Premium`);
      }
    }
    const now = new Date();
    const service = {
      ...req.validated,
      vendorId: req.user._id,
      status: "Pending",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("services").insertOne(service);
    sendResponse(res, 201, true, "Service created for review.", { ...service, _id: result.insertedId });
  } catch (error) { next(error); }
});

const updateServiceSchema = z.object({
  serviceName: z.string().trim().min(3).max(120).optional(),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  description: z.string().trim().min(10).max(2000).optional(),
  price: z.coerce.number().positive().optional(),
  location: z.string().trim().min(2).max(200).optional(),
  images: z.array(z.string().url()).min(1).max(5).optional(),
}).strict();

router.patch("/services/:id", validateBody(updateServiceSchema), async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    const service = await db.collection("services").findOne({ _id: id });
    if (!service) return sendResponse(res, 404, false, "Service not found.");
    if (String(service.vendorId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    const result = await db.collection("services").findOneAndUpdate(
      { _id: id, vendorId: vendorIdQuery(req.user._id) },
      { $set: { ...req.validated, status: "Pending", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    sendResponse(res, 200, true, "Service updated and submitted for review.", result);
  } catch (error) { next(error); }
});

router.patch("/services/:id/availability", validateBody(z.object({ isActive: z.boolean() }).strict()), async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    const service = await db.collection("services").findOne({ _id: id, vendorId: vendorIdQuery(req.user._id) });
    if (!service) return sendResponse(res, 404, false, "Service not found.");
    if (String(service.vendorId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    if (req.validated.isActive === true && getEffectivePlan(req.user) === "free") {
      const count = await countActiveServices(db, req.user._id, { excludeServiceId: id });
      const limit = getFreePlanServiceLimit();
      if (count >= limit) {
        return sendResponse(res, 403, false, `Free plan limit reached (${limit} active services). Upgrade to Premium`);
      }
    }
    const result = await db.collection("services").findOneAndUpdate(
      { _id: id, vendorId: vendorIdQuery(req.user._id) },
      { $set: { isActive: req.validated.isActive, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    sendResponse(res, 200, true, "Availability updated.", result ? { ...result, isActive: result.isActive !== false } : result);
  } catch (error) { next(error); }
});

router.delete("/services/:id", async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    const service = await db.collection("services").findOne({ _id: id });
    if (!service) return sendResponse(res, 404, false, "Service not found.");
    if (String(service.vendorId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    await db.collection("bookings").updateMany(
      { serviceId: id, status: "Pending" },
      { $set: { status: "Cancelled", updatedAt: new Date() } },
    );
    await db.collection("services").deleteOne({ _id: id, vendorId: vendorIdQuery(req.user._id) });
    sendResponse(res, 200, true, "Service deleted.");
  } catch (error) { next(error); }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const filter = { vendorId: vendorIdQuery(req.user._id) };
    if (req.query.status) filter.status = req.query.status;
    const bookings = await getDb().collection("bookings").find(filter).sort({ createdAt: -1 }).toArray();
    const ids = [...new Set(bookings.map((b) => b.customerId))];
    const serviceIds = [...new Set(bookings.map((b) => b.serviceId))];
    const db = getDb();
    const users = await db.collection(process.env.USERS_COLLECTION || "user")
      .find({ _id: { $in: ids } }, { projection: { name: 1, email: 1, image: 1 } }).toArray();
    const services = await db.collection("services").find({ _id: { $in: serviceIds } }, { projection: { serviceName: 1, images: 1 } }).toArray();
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const serviceMap = new Map(services.map((s) => [String(s._id), s]));
    const items = bookings.map((b) => ({
      ...b,
      customer: userMap.get(String(b.customerId)) || null,
      service: serviceMap.get(String(b.serviceId)) || null,
    }));
    sendResponse(res, 200, true, "Vendor bookings fetched.", items);
  } catch (error) { next(error); }
});

async function processVendorBooking(req, res, next, status) {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid booking id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    const booking = await db.collection("bookings").findOne({ _id: id });
    if (!booking) return sendResponse(res, 404, false, "Booking not found.");
    if (String(booking.vendorId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    if (booking.status !== "Pending") return sendResponse(res, 409, false, "Booking has already been processed.");
    const result = await db.collection("bookings").findOneAndUpdate(
      { _id: id, vendorId: vendorIdQuery(req.user._id), status: "Pending" },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) return sendResponse(res, 409, false, "Booking has already been processed.");
    sendResponse(res, 200, true, `Booking ${status}.`, result);
  } catch (error) { next(error); }
}

router.patch("/bookings/:id/accept", (req, res, next) => processVendorBooking(req, res, next, "Accepted"));
router.patch("/bookings/:id/reject", (req, res, next) => processVendorBooking(req, res, next, "Rejected"));

router.get("/subscription", async (req, res, next) => {
  try {
    const db = getDb();
    const activeServicesCount = await countActiveServices(db, req.user._id);
    sendResponse(res, 200, true, "Subscription fetched.", {
      ...subscriptionResponse(req.user, {
        limits: { activeServices: getFreePlanServiceLimit() },
        activeServicesCount,
      }),
    });
  } catch (error) { next(error); }
});

router.post("/subscription/resume", async (req, res, next) => {
  try {
    const user = await getDb().collection(process.env.USERS_COLLECTION || "user").findOne(
      { _id: req.user._id },
      { projection: { stripeSubscriptionId: 1 } },
    );
    const subscriptionId = user?.stripeSubscriptionId;
    if (!subscriptionId) {
      return sendResponse(res, 404, false, "No subscription found to resume.");
    }

    // Resume the existing Stripe subscription in place. The verified webhook
    // updates local plan state when Stripe confirms the change.
    const subscription = await getStripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });

    sendResponse(res, 200, true, "Request sent, your plan will update shortly", {
      subscriptionId: subscription?.id || null,
      cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    });
  } catch (error) { next(error); }
});

router.get("/transactions", async (req, res, next) => {
  try {
    const transactions = await getDb().collection("transactions")
      .find({ vendorId: vendorIdQuery(req.user._id) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const items = transactions.map((transaction) => {
      const plan = transaction.plan || transaction.subscriptionPlan || "premium";
      const amount = typeof transaction.amount === "number"
        ? transaction.amount
        : Number(transaction.amount || 0);
      return {
        ...transaction,
        id: String(transaction._id),
        plan,
        subscriptionPlan: transaction.subscriptionPlan || plan,
        amount: Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0,
        currency: (transaction.currency || "usd").toLowerCase(),
        status: transaction.status || "paid",
        periodStart: toIsoOrNull(transaction.periodStart),
        periodEnd: toIsoOrNull(transaction.periodEnd),
        date: transaction.createdAt || transaction.date || null,
      };
    });
    sendResponse(res, 200, true, "Vendor transactions fetched.", items);
  } catch (error) { next(error); }
});

export default router;
