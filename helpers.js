import { ObjectId } from "mongodb";

export const SERVICE_CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];
export const SERVICE_STATUSES = ["pending", "approved", "rejected"];
export const BOOKING_STATUSES = ["pending", "accepted", "rejected", "cancelled"];
export const USER_ROLES = ["vendor", "customer", "admin"];

export function sendResponse(res, status, success, message, data, errors) {
  const body = { success, message };
  if (data !== undefined) body.data = data;
  if (errors !== undefined) body.errors = errors;
  return res.status(status).json(body);
}

export function isValidObjectId(value) {
  return ObjectId.isValid(value) && String(new ObjectId(String(value))) === String(value);
}

export function toObjectId(value) {
  return isValidObjectId(value) ? new ObjectId(String(value)) : null;
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getEffectivePlan(user) {
  const expires = user?.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null;
  return user?.subscriptionPlan === "premium" &&
    expires instanceof Date &&
    !Number.isNaN(expires.getTime()) &&
    expires.getTime() > Date.now()
    ? "premium"
    : "free";
}

export function safeUser(user) {
  return {
    _id: user._id,
    name: user.name || "",
    email: user.email || "",
    image: user.image || null,
    role: USER_ROLES.includes(user.role) ? user.role : "customer",
    isBlocked: user.isBlocked === true,
    businessName: user.businessName || "",
    phone: user.phone || "",
    address: user.address || "",
    bio: user.bio || "",
    subscriptionPlan: user.subscriptionPlan === "premium" ? "premium" : "free",
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
  };
}
