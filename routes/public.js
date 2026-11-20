import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { connectDB, getDb } from "../db.js";
import { SERVICE_CATEGORIES, escapeRegex, getEffectivePlan, sendResponse, subscriptionResponse } from "../helpers.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG, PNG, WEBP, and GIF images are allowed"), false);
    }
  },
});
const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function visibleServiceStages(filter) {
  return [
    { $match: filter },
    { $lookup: {
      from: process.env.USERS_COLLECTION || "user",
      localField: "vendorId",
      foreignField: "_id",
      as: "vendor",
    } },
    { $unwind: "$vendor" },
    { $match: { "vendor.isBlocked": { $ne: true } } },
  ];
}

router.get("/categories", async (req, res, next) => {
  try {
    await connectDB();
    const db = getDb();
    const counts = await db.collection("services").aggregate([
      ...visibleServiceStages({ status: "Approved", isActive: { $ne: false } }),
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]).toArray();
    const countByCategory = new Map(counts.map(({ _id, count }) => [_id, count]));
    const items = SERVICE_CATEGORIES.map((category) => ({
      category,
      count: countByCategory.get(category) || 0,
    }));
    sendResponse(res, 200, true, "Categories fetched.", items);
  } catch (error) { next(error); }
});

router.get("/services", async (req, res, next) => {
  try {
    await connectDB();
    const db = getDb();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 12));
    const filter = { status: "Approved", isActive: { $ne: false } };
    if (req.query.search) filter.serviceName = { $regex: escapeRegex(req.query.search), $options: "i" };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.location) filter.location = { $regex: escapeRegex(req.query.location), $options: "i" };
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    if (minPrice !== null || maxPrice !== null) {
      filter.price = {};
      if (minPrice !== null && Number.isFinite(minPrice)) filter.price.$gte = minPrice;
      if (maxPrice !== null && Number.isFinite(maxPrice)) filter.price.$lte = maxPrice;
    }
    const sort = req.query.sort === "price_asc" ? { price: 1 }
      : req.query.sort === "price_desc" ? { price: -1 }
      : { createdAt: -1 };
    if (req.query.featured === "true") req.query.limit = "6";
    const actualLimit = req.query.featured === "true" ? 6 : limit;
    const featuredOnly = req.query.featured === "true";
    let premiumVendorIds = [];
    if (featuredOnly) {
      const candidateVendorIds = await db.collection("services").distinct("vendorId", filter);
      const vendors = candidateVendorIds.length
        ? await db.collection(process.env.USERS_COLLECTION || "user").find(
          { _id: { $in: candidateVendorIds } },
          {
            projection: {
              status: 1,
              subscriptionStatus: 1,
              currentPeriodEnd: 1,
              subscriptionExpiresAt: 1,
              subscriptionPlan: 1,
            },
          },
        ).toArray()
        : [];
      // Featured placement uses the same single source of truth as the API.
      premiumVendorIds = vendors
        .filter((vendor) => getEffectivePlan(vendor) === "premium")
        .map((vendor) => vendor._id);
    }
    const pipeline = [
      ...(featuredOnly ? [{ $match: { vendorId: { $in: premiumVendorIds } } }] : []),
      ...visibleServiceStages(filter),
      { $sort: sort },
      { $skip: featuredOnly ? 0 : (page - 1) * actualLimit },
      { $limit: actualLimit },
      { $project: {
        serviceName: 1, category: 1, description: 1, price: 1, location: 1, images: 1,
        status: 1, isActive: 1, createdAt: 1, updatedAt: 1, vendorId: 1,
        vendor: { _id: "$vendor._id", name: "$vendor.name", image: "$vendor.image", businessName: "$vendor.businessName" }
      } },
    ];
    const items = await db.collection("services").aggregate(pipeline).toArray();
    for (const item of items) {
      const vendor = await db.collection(process.env.USERS_COLLECTION || "user").findOne(
        { _id: item.vendorId },
        { projection: { name: 1, image: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, plan: 1, status: 1, subscriptionStatus: 1, cancelAtPeriodEnd: 1, currentPeriodEnd: 1, isPremium: 1, isFeatured: 1 } },
      );
      const subscription = vendor ? subscriptionResponse(vendor) : null;
      item.vendor = vendor ? {
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
      } : null;
      item.isPremium = subscription?.isPremium === true;
    }
    const totalCount = await db.collection("services").aggregate([
      ...visibleServiceStages(filter),
      { $count: "total" },
    ]).toArray();
    const total = totalCount[0]?.total || 0;
    sendResponse(res, 200, true, "Services fetched.", {
      items,
      total,
      page: featuredOnly ? 1 : page,
      limit: actualLimit,
      pages: Math.ceil(total / actualLimit),
    });
  } catch (error) { next(error); }
});

router.post("/upload", uploadLimit, (req, res, next) => {
  upload.single("image")(req, res, async (error) => {
    if (error) return sendResponse(res, 400, false, error.message || "Invalid upload.");
    if (!req.file) return sendResponse(res, 400, false, "Image file is required.");
    try {
      const form = new FormData();
      form.append("image", new Blob([req.file.buffer], { type: req.file.mimetype }));
      const response = await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok || !result?.data?.url) {
        return sendResponse(res, 502, false, "Image upload failed.");
      }
      sendResponse(res, 200, true, "Image uploaded.", { url: result.data.url });
    } catch (uploadError) { next(uploadError); }
  });
});

export default router;
