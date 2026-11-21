import { ObjectId } from "mongodb";

export const SERVICE_CATEGORIES = [
  "Photography & Videography",
  "Wedding Venues",
  "Decoration & Florist",
  "Catering Services",
  "Makeup & Styling",
  "Wedding Fashion",
];
export const SERVICE_STATUSES = ["Pending", "Approved", "Rejected"];
export const BOOKING_STATUSES = ["Pending", "Accepted", "Rejected", "Cancelled"];
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

// Services may have been written with an ObjectId or a string vendorId. Match
// both representations so counts and downgrades cannot silently see zero rows.
export function vendorIdQuery(vendorId) {
  const values = [];
  const seen = new Set();
  const push = (value) => {
    if (value === undefined || value === null || value === "") return;
    const kind = value instanceof ObjectId ? "objectId" : typeof value;
    const key = `${kind}:${String(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push(value);
  };

  const objectId = toObjectId(vendorId);
  if (objectId) push(objectId);
  push(vendorId);
  push(String(vendorId));

  return { $in: values };
}

// One definition of an "active" service across the API and webhooks:
// explicitly disabled services and rejected services are excluded; legacy
// documents with no isActive field remain active.
export function activeServiceFilter(vendorId, { excludeServiceId } = {}) {
  const filter = {
    vendorId: vendorIdQuery(vendorId),
    isActive: { $ne: false },
    status: { $ne: "Rejected" },
  };
  if (excludeServiceId) {
    filter._id = { $ne: toObjectId(excludeServiceId) || excludeServiceId };
  }
  return filter;
}

export async function countActiveServices(db, vendorId, options) {
  return db.collection("services").countDocuments(activeServiceFilter(vendorId, options));
}

export async function findActiveServices(db, vendorId) {
  return db.collection("services")
    .find(activeServiceFilter(vendorId))
    .sort({ createdAt: 1 })
    .toArray();
}

export function getFreePlanServiceLimit() {
  const parsed = Number.parseInt(process.env.FREE_PLAN_SERVICE_LIMIT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function stripeUnixDate(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

// Stripe API 2026-10-28 moved current_period_start/end onto subscription items.
// Prefer the item values and fall back to the legacy top-level fields.
export function subscriptionPeriodDatesFromStripe(subscription) {
  const item = subscription?.items?.data?.[0];
  return {
    currentPeriodStart: stripeUnixDate(item?.current_period_start ?? subscription?.current_period_start),
    currentPeriodEnd: stripeUnixDate(item?.current_period_end ?? subscription?.current_period_end),
  };
}

export function subscriptionPeriodStartFromStripe(subscription) {
  return subscriptionPeriodDatesFromStripe(subscription).currentPeriodStart;
}

export function subscriptionPeriodEndFromStripe(subscription) {
  return subscriptionPeriodDatesFromStripe(subscription).currentPeriodEnd;
}

export function invoicePeriodDatesFromStripe(invoice) {
  const period = invoice?.lines?.data?.[0]?.period;
  return {
    periodStart: stripeUnixDate(period?.start ?? invoice?.period_start),
    periodEnd: stripeUnixDate(period?.end ?? invoice?.period_end),
  };
}

export function toIsoOrNull(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing"];

export function getCurrentPeriodStart(user) {
  return toDate(user?.currentPeriodStart);
}

export function getCurrentPeriodEnd(user) {
  // Canonical field first; legacy alias only supports older documents.
  return toDate(user?.currentPeriodEnd) || toDate(user?.subscriptionExpiresAt);
}

export function getStoredStatus(user) {
  const raw = user?.subscriptionStatus ?? user?.status;
  if (typeof raw === "string" && raw) {
    // Legacy "cancelling" documents still represent an active subscription
    // with cancel_at_period_end set.
    if (raw === "cancelling") return "active";
    return raw;
  }
  // Legacy documents may only have subscriptionPlan + subscriptionExpiresAt.
  if (user?.subscriptionPlan === "premium" && getCurrentPeriodEnd(user)?.getTime() > Date.now()) {
    return "active";
  }
  return "free";
}

// THE single source of truth for entitlement. Stored `plan` fields are
// denormalized snapshots; this helper always recomputes from status + expiry.
export function getEffectivePlan(user) {
  const expires = getCurrentPeriodEnd(user);
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(getStoredStatus(user)) &&
    expires && expires.getTime() > Date.now()
    ? "premium"
    : "free";
}

export function getCancelAtPeriodEnd(user) {
  if (typeof user?.cancelAtPeriodEnd === "boolean") return user.cancelAtPeriodEnd;
  return user?.cancelAtPeriodEndLegacy === true;
}

// Account blocking is separate from subscription status. `status` is also used
// as a legacy subscription field, so accountStatus/isBlocked are authoritative.
export function isUserBlocked(user) {
  return user?.isBlocked === true ||
    user?.accountStatus === "blocked" ||
    user?.status === "blocked";
}

export function getAccountStatus(user) {
  return isUserBlocked(user) ? "blocked" : "active";
}

export function getSubscriptionStatus(user) {
  const stored = getStoredStatus(user);
  const effective = getEffectivePlan(user);
  const raw = user?.subscriptionStatus ?? user?.status;

  if (effective === "premium" && (getCancelAtPeriodEnd(user) || raw === "cancelling")) {
    return "cancelling";
  }
  if (effective === "free" && ACTIVE_SUBSCRIPTION_STATUSES.includes(stored) && getCurrentPeriodEnd(user)) {
    return "expired";
  }
  return stored || "free";
}

// Every plan write goes through this helper so all denormalized fields are
// updated atomically and cannot drift apart.
export function buildVendorPlanUpdate({
  status,
  cancelAtPeriodEnd = false,
  currentPeriodStart,
  currentPeriodEnd,
  customerId,
  subscriptionId,
  priceId,
  clearStripeSubscription = false,
} = {}) {
  const start = toDate(currentPeriodStart);
  const expiry = toDate(currentPeriodEnd);
  const rawStatus = typeof status === "string" && status ? status : "free";
  const plan = ACTIVE_SUBSCRIPTION_STATUSES.includes(rawStatus) && expiry && expiry.getTime() > Date.now()
    ? "premium"
    : "free";
  const cancelling = plan === "premium" && cancelAtPeriodEnd === true;

  const $set = {
    plan,
    subscriptionPlan: plan,
    status: rawStatus,
    subscriptionStatus: rawStatus,
    cancelAtPeriodEnd: cancelling,
    currentPeriodStart: plan === "premium" ? start : null,
    currentPeriodEnd: plan === "premium" ? expiry : null,
    subscriptionExpiresAt: plan === "premium" ? expiry : null,
    // Denormalized badge/featured flags, derived from the same effective plan.
    isPremium: plan === "premium",
    isFeatured: plan === "premium",
    updatedAt: new Date(),
  };
  if (customerId) $set.stripeCustomerId = customerId;
  if (subscriptionId) $set.stripeSubscriptionId = subscriptionId;
  if (priceId) $set.stripePriceId = priceId;
  if (clearStripeSubscription) {
    $set.stripeSubscriptionId = null;
    $set.stripePriceId = null;
  }
  return $set;
}

export function subscriptionResponse(user, extra = {}) {
  const plan = getEffectivePlan(user);
  const startsAt = plan === "premium" ? getCurrentPeriodStart(user) : null;
  const expiresAt = plan === "premium" ? getCurrentPeriodEnd(user) : null;
  const currentPeriodStart = toIsoOrNull(startsAt);
  const currentPeriodEnd = toIsoOrNull(expiresAt);
  const storedStatus = getStoredStatus(user);
  return {
    plan,
    currentPlan: plan,
    effectivePlan: plan,
    subscriptionPlan: plan,
    status: getSubscriptionStatus(user),
    subscriptionStatus: storedStatus,
    cancelAtPeriodEnd: getCancelAtPeriodEnd(user) === true,
    currentPeriodStart,
    currentPeriodEnd,
    expiresAt: currentPeriodEnd,
    subscriptionExpiresAt: currentPeriodEnd,
    isPremium: plan === "premium",
    isFeatured: plan === "premium",
    ...extra,
  };
}

export function safeUser(user) {
  const subscription = subscriptionResponse(user);
  return {
    _id: user._id,
    name: user.name || "",
    email: user.email || "",
    image: user.image || null,
    role: USER_ROLES.includes(user.role) ? user.role : "customer",
    isBlocked: isUserBlocked(user),
    accountStatus: getAccountStatus(user),
    businessName: user.businessName || "",
    phone: user.phone || "",
    address: user.address || "",
    bio: user.bio || "",
    ...subscription,
  };
}
