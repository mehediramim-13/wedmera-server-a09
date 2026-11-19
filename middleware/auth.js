import { ObjectId } from "mongodb";
import { getDb } from "../db.js";
import { sendResponse } from "../helpers.js";
import { sendUnauthorized } from "./unauthorized.js";
import { verifyToken } from "../verifyJwt.js";

const isDevelopment = () => process.env.NODE_ENV !== "production";

function readBearerToken(req) {
  // Express header lookup is case-insensitive, so "Authorization",
  // "authorization", and any other casing all resolve here.
  const header = req.get("authorization");
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function toObjectId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ObjectId.isValid(trimmed) ? new ObjectId(trimmed) : null;
}

function identityClaims(payload) {
  const claims = [];
  const seen = new Set();
  for (const [name, raw] of [["sub", payload?.sub], ["id", payload?.id]]) {
    const value = typeof raw === "number" ? String(raw) : raw;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    claims.push({ name, value: trimmed });
  }
  return claims;
}

async function findUser(users, payload) {
  let matchedBy = null;

  for (const { name, value } of identityClaims(payload)) {
    const objectId = toObjectId(value);
    if (objectId) {
      const user = await users.findOne({ _id: objectId });
      if (user) return { user, matchedBy: `_id:ObjectId(${name})` };
    }

    const byId = await users.findOne({ id: value });
    if (byId) return { user: byId, matchedBy: `id:${name}` };

    const byStringId = await users.findOne({ _id: value });
    if (byStringId) return { user: byStringId, matchedBy: `_id:string(${name})` };
  }

  if (typeof payload?.email === "string" && payload.email.trim()) {
    const email = payload.email.trim();
    const user = await users.findOne({ email });
    if (user) return { user, matchedBy: "email" };
    const lowerCaseEmail = email.toLowerCase();
    if (lowerCaseEmail !== email) {
      const caseInsensitiveUser = await users.findOne({ email: lowerCaseEmail });
      if (caseInsensitiveUser) return { user: caseInsensitiveUser, matchedBy: "email:lowercase" };
    }
  }

  return { user: null, matchedBy };
}

export async function requireAuth(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    return sendUnauthorized(res, "missing_token", "Missing or invalid Authorization header.");
  }

  let payload;
  try {
    ({ payload } = await verifyToken(token));
  } catch (error) {
    const code = error?.code || error?.name || "unknown";
    return sendUnauthorized(
      res,
      "invalid_token",
      "Invalid or expired token.",
      `code=${code}, message=${error?.message || "JWT verification failed"}`,
    );
  }

  try {
    const users = getDb().collection(process.env.USERS_COLLECTION || "user");
    const { user, matchedBy } = await findUser(users, payload);
    if (!user) {
      return sendUnauthorized(res, "user_not_found", "User not found.");
    }
    if (isDevelopment()) {
      console.info(`Authentication user lookup matched by ${matchedBy}.`);
    }
    // Blocking is always enforced from the database, never from token claims.
    if (user.isBlocked === true) return sendResponse(res, 403, false, "Your account is blocked");

    req.user = {
      ...user,
      role: ["vendor", "customer", "admin"].includes(user.role) ? user.role : "customer",
      isBlocked: user.isBlocked === true,
      subscriptionPlan: user.subscriptionPlan === "premium" ? "premium" : "free",
    };
    return next();
  } catch (error) {
    return next(error);
  }
}
