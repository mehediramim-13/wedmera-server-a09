import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { sendResponse, isValidObjectId } from "../helpers.js";
import { verifyToken } from "../verifyJwt.js";

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return sendResponse(res, 401, false, "Missing or invalid Authorization header.");
  const token = header.slice(7).trim();
  if (!token) return sendResponse(res, 401, false, "Missing or invalid Authorization header.");

  try {
    const { payload } = await verifyToken(token);
    const users = getDb().collection(process.env.USERS_COLLECTION || "user");
    let user = null;

    if (payload.sub && isValidObjectId(payload.sub)) {
      user = await users.findOne({ _id: new ObjectId(payload.sub) });
    }
    if (!user && payload.id) {
      user = await users.findOne({ id: String(payload.id) });
    }
    if (!user && payload.sub) {
      user = await users.findOne({ id: String(payload.sub) });
    }
    if (!user && payload.email) {
      user = await users.findOne({ email: String(payload.email).toLowerCase() });
    }
    if (!user) return sendResponse(res, 401, false, "User not found.");
    if (user.isBlocked === true) return sendResponse(res, 403, false, "Your account is blocked");

    req.user = {
      ...user,
      role: ["vendor", "customer", "admin"].includes(user.role) ? user.role : "customer",
      isBlocked: user.isBlocked === true,
      subscriptionPlan: user.subscriptionPlan === "premium" ? "premium" : "free",
    };
    next();
  } catch (error) {
    if (error?.code === "ERR_JWT_EXPIRED" || error?.name === "JWTExpired") {
      return sendResponse(res, 401, false, "Your session has expired.");
    }
    return sendResponse(res, 401, false, "Invalid or expired token.");
  }
}
