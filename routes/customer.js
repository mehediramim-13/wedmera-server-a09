import { Router } from "express";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { isValidObjectId, sendResponse, toObjectId } from "../helpers.js";

const router = Router();
router.use(requireAuth, requireRole("customer"));

router.get("/overview", async (req, res, next) => {
  try {
    const db = getDb();
    const [totalBookings, pending, accepted, rejected, cancelled] = await Promise.all([
      db.collection("bookings").countDocuments({ customerId: req.user._id }),
      db.collection("bookings").countDocuments({ customerId: req.user._id, status: "pending" }),
      db.collection("bookings").countDocuments({ customerId: req.user._id, status: "accepted" }),
      db.collection("bookings").countDocuments({ customerId: req.user._id, status: "rejected" }),
      db.collection("bookings").countDocuments({ customerId: req.user._id, status: "cancelled" }),
    ]);
    sendResponse(res, 200, true, "Customer overview fetched.", { totalBookings, pending, accepted, rejected, cancelled });
  } catch (error) { next(error); }
});

router.get("/bookings", async (req, res, next) => {
  try {
    const filter = { customerId: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    const db = getDb();
    const bookings = await db.collection("bookings").find(filter).sort({ createdAt: -1 }).toArray();
    const serviceIds = [...new Set(bookings.map((b) => b.serviceId))];
    const vendorIds = [...new Set(bookings.map((b) => b.vendorId))];
    const [services, vendors] = await Promise.all([
      db.collection("services").find({ _id: { $in: serviceIds } }, { projection: { serviceName: 1, images: 1 } }).toArray(),
      db.collection(process.env.USERS_COLLECTION || "user").find({ _id: { $in: vendorIds } }, { projection: { name: 1, businessName: 1, image: 1 } }).toArray(),
    ]);
    const serviceMap = new Map(services.map((s) => [String(s._id), s]));
    const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
    const items = bookings.map((b) => ({
      ...b,
      service: serviceMap.get(String(b.serviceId)) || null,
      vendor: vendorMap.get(String(b.vendorId)) || null,
    }));
    sendResponse(res, 200, true, "Customer bookings fetched.", items);
  } catch (error) { next(error); }
});

router.get("/bookings/:id", async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid booking id");
  try {
    const booking = await getDb().collection("bookings").findOne({ _id: toObjectId(req.params.id) });
    if (!booking) return sendResponse(res, 404, false, "Booking not found.");
    if (String(booking.customerId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    sendResponse(res, 200, true, "Booking fetched.", booking);
  } catch (error) { next(error); }
});

router.patch("/bookings/:id/cancel", async (req, res, next) => {
  if (!isValidObjectId(req.params.id)) return sendResponse(res, 400, false, "Invalid booking id");
  try {
    const db = getDb();
    const id = toObjectId(req.params.id);
    const booking = await db.collection("bookings").findOne({ _id: id });
    if (!booking) return sendResponse(res, 404, false, "Booking not found.");
    if (String(booking.customerId) !== String(req.user._id)) return sendResponse(res, 403, false, "Forbidden.");
    if (booking.status !== "pending") return sendResponse(res, 409, false, "Only pending bookings can be cancelled.");
    const result = await db.collection("bookings").findOneAndUpdate(
      { _id: id, customerId: req.user._id, status: "pending" },
      { $set: { status: "cancelled", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) return sendResponse(res, 409, false, "Only pending bookings can be cancelled.");
    sendResponse(res, 200, true, "Booking cancelled.", result);
  } catch (error) { next(error); }
});

export default router;
