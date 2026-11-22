import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { validateBody } from "../middleware/validate.js";
import { escapeRegex, getAccountStatus, isUserBlocked, isValidObjectId, sendResponse, subscriptionResponse, toIsoOrNull, toObjectId, SERVICE_CATEGORIES } from "../helpers.js";

const router = Router();
router.use(requireAuth, requireRole("admin"));

const userProjection = {
  name: 1, email: 1, image: 1, role: 1, isBlocked: 1, accountStatus: 1,
  businessName: 1, phone: 1, address: 1, bio: 1,
  subscriptionPlan: 1, subscriptionExpiresAt: 1, plan: 1, status: 1,
  subscriptionStatus: 1, cancelAtPeriodEnd: 1, currentPeriodStart: 1,
  currentPeriodEnd: 1, isPremium: 1, isFeatured: 1, createdAt: 1,
};

function withEffectivePlan(user) {
  const subscription = subscriptionResponse(user);
  const accountStatus = getAccountStatus(user);
  const { status: planStatus, subscriptionStatus, ...planFields } = subscription;
  return {
    ...user,
    ...planFields,
    accountStatus,
    isBlocked: isUserBlocked(user),
    // The admin dashboard expects `status` to be the account status.
    status: accountStatus,
    subscriptionStatus,
    planStatus,
  };
}

router.get("/overview", async (req, res, next) => {
  try {
    const db = getDb();
    const users = db.collection(process.env.USERS_COLLECTION || "user");
    const [totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions, paidTransactions] =
      await Promise.all([
        users.countDocuments({}),
        users.countDocuments({ role: "vendor" }),
        users.countDocuments({ role: "customer" }),
        db.collection("services").countDocuments({}),
        db.collection("services").countDocuments({ status: "Pending" }),
        db.collection("transactions").countDocuments({}),
        db.collection("transactions").aggregate([
          { $match: { status: "paid" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]).toArray(),
      ]);
    sendResponse(res, 200, true, "Admin overview fetched.", {
      totalUsers, totalVendors, totalCustomers, totalServices, pendingServices, totalTransactions,
      totalRevenue: paidTransactions[0]?.total || 0,
    });
  } catch (error) { next(error); }
});

router.get("/users", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {};
    if (req.query.search) {
      const regex = escapeRegex(req.query.search);
      filter.$or = [{ name: { $regex: regex, $options: "i" } }, { email: { $regex: regex, $options: "i" } }];
    }
    if (req.query.role) filter.role = req.query.role;
    const users = getDb().collection(process.env.USERS_COLLECTION || "user");
    const [items, total] = await Promise.all([
      users.find(filter, { projection: userProjection })
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      users.countDocuments(filter),
    ]);
    sendResponse(res, 200, true, "Users fetched.", {
      items: items.map(withEffectivePlan), total, page, limit, pages: Math.ceil(total / limit),
    });
  } catch (error) { next(error); }
});

router.get("/users/:id", async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid user id");
  try {
    const db = getDb();
    const user = await db.collection(process.env.USERS_COLLECTION || "user").findOne(
      { _id: toObjectId(req.params.id) },
      { projection: userProjection },
    );
    if (!user) return sendResponse(res, 404, false, "User not found.");
    const [servicesCount, bookingsCount] = await Promise.all([
      db.collection("services").countDocuments({ vendorId: user._id }),
      db.collection("bookings").countDocuments({ $or: [{ customerId: user._id }, { vendorId: user._id }] }),
    ]);
    sendResponse(res, 200, true, "User fetched.", {
      ...withEffectivePlan(user),
      counts: { services: servicesCount, bookings: bookingsCount },
    });
  } catch (error) { next(error); }
});

const accountStatusSchema = z.object({
  status: z.enum(["blocked", "active"]),
}).strict();

async function setAccountStatus(req, res, next, status) {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid user id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    if (String(id) === String(req.user._id)) {
      return sendResponse(res, 403, false, "Cannot block or unblock yourself.");
    }
    const users = db.collection(process.env.USERS_COLLECTION || "user");
    const user = await users.findOne({ _id: id }, { projection: { role: 1 } });
    if (!user) return sendResponse(res, 404, false, "User not found.");
    if (user.role === "admin") return sendResponse(res, 403, false, "Cannot block or unblock an admin.");

    const blocked = status === "blocked";
    const updated = await users.findOneAndUpdate(
      { _id: id },
      { $set: { accountStatus: status, isBlocked: blocked, updatedAt: new Date() } },
      { returnDocument: "after", projection: userProjection },
    );
    sendResponse(res, 200, true, blocked ? "User blocked." : "User unblocked.", withEffectivePlan(updated));
  } catch (error) { next(error); }
}

// Dashboard contract: PATCH /api/admin/users/:id { "status": "blocked" | "active" }
router.patch("/users/:id", validateBody(accountStatusSchema), (req, res, next) =>
  setAccountStatus(req, res, next, req.validated.status));

// Keep the older explicit block/unblock endpoints working as well.
router.patch("/users/:id/block", (req, res, next) => setAccountStatus(req, res, next, "blocked"));
router.patch("/users/:id/unblock", (req, res, next) => setAccountStatus(req, res, next, "active"));

router.get("/services", async (req, res, next) => {
  try {
    const db = getDb();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {};
    if (req.query.search) filter.serviceName = { $regex: escapeRegex(req.query.search), $options: "i" };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.category) filter.category = req.query.category;
    const [items, total] = await Promise.all([
      db.collection("services").find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      db.collection("services").countDocuments(filter),
    ]);
    const vendorIds = [...new Set(items.map((item) => item.vendorId))];
    const vendors = await db.collection(process.env.USERS_COLLECTION || "user")
      .find({ _id: { $in: vendorIds } }, { projection: { name: 1, email: 1, image: 1, businessName: 1, isBlocked: 1 } }).toArray();
    const map = new Map(vendors.map((v) => [String(v._id), v]));
    sendResponse(res, 200, true, "Services fetched.", {
      items: items.map((item) => ({ ...item, vendor: map.get(String(item.vendorId)) || null })),
      total, page, limit, pages: Math.ceil(total / limit),
    });
  } catch (error) { next(error); }
});

const serviceModerationSchema = z.object({
  status: z.enum(["Approved", "Rejected"]),
}).strict();

async function updateServiceStatus(req, res, next) {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const result = await getDb().collection("services").findOneAndUpdate(
      { _id: toObjectId(req.params.id) },
      { $set: { status: req.validated.status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) return sendResponse(res, 404, false, "Service not found.");
    sendResponse(res, 200, true, "Service status updated.", result);
  } catch (error) { next(error); }
}

// Established API contract: PATCH /api/admin/services/:id/status
router.patch("/services/:id/status", validateBody(serviceModerationSchema), updateServiceStatus);

// Admin dashboard contract: PATCH /api/admin/services/:id with { status }.
// Keep both mounted so existing clients are not broken.
router.patch("/services/:id", validateBody(serviceModerationSchema), updateServiceStatus);

router.delete("/services/:id", async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    if (!await db.collection("services").findOne({ _id: id })) return sendResponse(res, 404, false, "Service not found.");
    await db.collection("bookings").updateMany({ serviceId: id, status: "Pending" }, { $set: { status: "Cancelled", updatedAt: new Date() } });
    await db.collection("services").deleteOne({ _id: id });
    sendResponse(res, 200, true, "Service deleted.");
  } catch (error) { next(error); }
});

router.get("/transactions", async (req, res, next) => {
  try {
    const db = getDb();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.plan) filter.plan = req.query.plan;
    const [items, total] = await Promise.all([
      db.collection("transactions").find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      db.collection("transactions").countDocuments(filter),
    ]);
    const vendorIds = [...new Set(items.map((item) => item.vendorId).filter(Boolean))];
    const vendors = await db.collection(process.env.USERS_COLLECTION || "user")
      .find({ _id: { $in: vendorIds } }, { projection: { name: 1, email: 1, image: 1, businessName: 1 } }).toArray();
    const map = new Map(vendors.map((v) => [String(v._id), v]));
    sendResponse(res, 200, true, "Transactions fetched.", {
      items: items.map((item) => ({
        ...item,
        periodStart: toIsoOrNull(item.periodStart),
        periodEnd: toIsoOrNull(item.periodEnd),
        vendor: map.get(String(item.vendorId)) || null,
      })),
      total, page, limit, pages: Math.ceil(total / limit),
    });
  } catch (error) { next(error); }
});

export default router;
