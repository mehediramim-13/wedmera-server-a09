import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { validateBody } from "../middleware/validate.js";
import { isValidObjectId, sendResponse, toObjectId } from "../helpers.js";

const router = Router();
router.use(requireAuth);

function startOfTodayInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const bookingSchema = z.object({
  serviceId: z.string(),
  eventDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  eventLocation: z.string().trim().min(2).max(300),
  message: z.string().trim().max(1000).optional().default(""),
}).strict();

router.post("/", requireRole("customer"), validateBody(bookingSchema), async (req, res, next) => {
  if (!isValidObjectId(req.validated.serviceId)) return sendResponse(res, 400, false, "Invalid service id");
  try {
    const db = getDb();
    const service = await db.collection("services").findOne({ _id: toObjectId(req.validated.serviceId) });
    if (!service) return sendResponse(res, 404, false, "Service not found.");
    if (service.status !== "Approved" || service.isActive === false) return sendResponse(res, 404, false, "Service not found.");
    if (String(service.vendorId) === String(req.user._id)) return sendResponse(res, 403, false, "You cannot book your own service.");
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(req.validated.eventDate)
      ? new Date(`${req.validated.eventDate}T00:00:00.000Z`)
      : new Date(req.validated.eventDate);
    if (Number.isNaN(eventDate.getTime())) return sendResponse(res, 400, false, "Event date is invalid.");
    const dateOnly = eventDate.toISOString().slice(0, 10);
    if (dateOnly <= startOfTodayInTimezone(process.env.APP_TIMEZONE)) {
      return sendResponse(res, 400, false, "Event date must be in the future.");
    }
    const duplicate = await db.collection("bookings").findOne({
      customerId: req.user._id,
      serviceId: service._id,
      eventDate,
      status: { $in: ["Pending", "Accepted"] },
    });
    if (duplicate) return sendResponse(res, 409, false, "An active booking already exists for this service and date.");
    const now = new Date();
    const booking = {
      serviceId: service._id,
      vendorId: service.vendorId,
      customerId: req.user._id,
      eventDate,
      eventLocation: req.validated.eventLocation,
      message: req.validated.message,
      status: "Pending",
      createdAt: now,
      updatedAt: now,
    };
    const result = await db.collection("bookings").insertOne(booking);
    sendResponse(res, 201, true, "Booking created.", { ...booking, _id: result.insertedId });
  } catch (error) { next(error); }
});

export default router;
