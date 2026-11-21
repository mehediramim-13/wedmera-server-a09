import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { isUserBlocked, isValidObjectId, sendResponse, subscriptionResponse, toObjectId } from "../helpers.js";

const router = Router();

router.get("/:id", requireAuth, async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const service = await db.collection("services").findOne({ _id: toObjectId(req.params.id) });
    if (!service) return sendResponse(res, 404, false, "Service not found.");
    const isOwner = String(service.vendorId) === String(req.user._id);
    if (!isOwner && req.user.role !== "admin" &&
      (service.status !== "Approved" || service.isActive === false)) {
      return sendResponse(res, 404, false, "Service not found.");
    }
    const vendor = await db.collection(process.env.USERS_COLLECTION || "user").findOne(
      { _id: service.vendorId },
      { projection: { name: 1, image: 1, businessName: 1, isBlocked: 1, accountStatus: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, plan: 1, status: 1, subscriptionStatus: 1, cancelAtPeriodEnd: 1, currentPeriodEnd: 1, isPremium: 1, isFeatured: 1 } },
    );
    if (!isOwner && req.user.role !== "admin" && isUserBlocked(vendor)) {
      return sendResponse(res, 404, false, "Service not found.");
    }
    const subscription = vendor ? subscriptionResponse(vendor) : null;
    sendResponse(res, 200, true, "Service fetched.", {
      ...service,
      vendor: vendor ? {
        _id: vendor._id,
        name: vendor.name || "",
        image: vendor.image || null,
        businessName: vendor.businessName || "",
        isPremium: subscription.isPremium,
        isFeatured: subscription.isFeatured,
        status: subscription.status,
        subscriptionStatus: subscription.subscriptionStatus,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      } : null,
    });
  } catch (error) { next(error); }
});

export default router;
