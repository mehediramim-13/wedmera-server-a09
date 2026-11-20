import { Router } from "express";
import { z } from "zod";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { safeUser, sendResponse } from "../helpers.js";

const router = Router();

router.use(requireAuth);

router.get("/me", (req, res) => {
  sendResponse(res, 200, true, "Profile fetched.", safeUser(req.user));
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  image: z.string().url().or(z.literal("")).optional(),
  businessName: z.string().trim().max(150).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  bio: z.string().trim().max(1000).optional(),
}).strict();

router.patch("/me", validateBody(profileSchema), async (req, res, next) => {
  try {
    await getDb().collection(process.env.USERS_COLLECTION || "user").updateOne(
      { _id: req.user._id },
      { $set: { ...req.validated, updatedAt: new Date() } },
    );
    const updated = await getDb().collection(process.env.USERS_COLLECTION || "user").findOne({ _id: req.user._id });
    sendResponse(res, 200, true, "Profile updated.", safeUser(updated));
  } catch (error) { next(error); }
});

export default router;
