import { Router } from "express";
import Stripe from "stripe";
import { connectDB, getDb } from "../db.js";
import { toObjectId } from "../helpers.js";

const router = Router();
const FALLBACK_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing required environment variable: STRIPE_SECRET_KEY");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function log(stage, details = {}) {
  console.log("[stripe-webhook]", JSON.stringify({ stage, ...details }));
}

function logError(stage, details = {}) {
  console.error("[stripe-webhook]", JSON.stringify({ stage, ...details }));
}

function usersCollection(db) {
  return db.collection(process.env.USERS_COLLECTION || "user");
}

function asStripeId(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

function normalizeVendorId(value) {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

// Better Auth may store the user key as an ObjectId, a string _id, or an `id`
// field. Match all supported forms so a paid webhook can never silently miss.
function vendorFilter(vendorId) {
  const value = String(vendorId).trim();
  const conditions = [{ _id: value }, { id: value }];
  const objectId = toObjectId(value);
  if (objectId) conditions.unshift({ _id: objectId });
  return { $or: conditions };
}

function amountInUsd(cents) {
  return typeof cents === "number" && Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
}

function isFutureDate(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date instanceof Date && !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}

function subscriptionPeriodEnd(subscription) {
  const timestamp = subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end;
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

function invoicePeriodEnd(invoice) {
  const timestamp = invoice?.period_end ??
    invoice?.lines?.data?.[0]?.period?.end;
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

function periodEndOrFallback(...candidates) {
  for (const candidate of candidates) {
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
  }
  return new Date(Date.now() + FALLBACK_PERIOD_MS);
}

function subscriptionPriceId(subscription) {
  return asStripeId(subscription?.items?.data?.[0]?.price) ||
    asStripeId(subscription?.plan) ||
    null;
}

async function findVendorUser(db, vendorId) {
  if (!vendorId) return null;
  return usersCollection(db).findOne(
    vendorFilter(vendorId),
    { projection: { _id: 1, id: 1, email: 1 } },
  );
}

async function vendorIdFromSession(db, session) {
  const fromMetadata = normalizeVendorId(session?.metadata?.vendorId) ||
    normalizeVendorId(session?.client_reference_id);
  if (fromMetadata) return fromMetadata;

  const customerId = asStripeId(session?.customer);
  if (customerId) {
    const byCustomer = await usersCollection(db).findOne({ stripeCustomerId: customerId });
    if (byCustomer) return String(byCustomer._id);
  }

  const subscriptionId = asStripeId(session?.subscription);
  if (subscriptionId) {
    const bySubscription = await usersCollection(db).findOne({ stripeSubscriptionId: subscriptionId });
    if (bySubscription) return String(bySubscription._id);
  }

  return null;
}

async function vendorIdFromSubscription(db, subscription) {
  const fromMetadata = normalizeVendorId(subscription?.metadata?.vendorId);
  if (fromMetadata) return fromMetadata;

  const customerId = asStripeId(subscription?.customer);
  if (customerId) {
    const byCustomer = await usersCollection(db).findOne({ stripeCustomerId: customerId });
    if (byCustomer) return String(byCustomer._id);
  }

  const subscriptionId = asStripeId(subscription?.id);
  if (subscriptionId) {
    const bySubscription = await usersCollection(db).findOne({ stripeSubscriptionId: subscriptionId });
    if (bySubscription) return String(bySubscription._id);
  }

  return null;
}

async function vendorIdFromInvoice(db, invoice) {
  const fromMetadata = normalizeVendorId(invoice?.metadata?.vendorId);
  if (fromMetadata) return fromMetadata;

  const customerId = asStripeId(invoice?.customer);
  if (customerId) {
    const byCustomer = await usersCollection(db).findOne({ stripeCustomerId: customerId });
    if (byCustomer) return String(byCustomer._id);
  }

  return null;
}

async function requireVendorUser(db, vendorId, context) {
  if (!vendorId) {
    logError("vendor_id_missing", context);
    throw new Error(`Missing vendorId for ${context.handler}`);
  }
  const user = await findVendorUser(db, vendorId);
  if (!user) {
    logError("vendor_user_not_found", { ...context, vendorId });
    throw new Error(`No user found for vendorId ${vendorId}`);
  }
  log("vendor_matched", { ...context, vendorId, userId: String(user._id) });
  return user;
}

async function updateVendorUser(db, vendorId, $set, context) {
  const result = await usersCollection(db).updateOne(
    vendorFilter(vendorId),
    { $set: { ...$set, updatedAt: new Date() } },
  );
  log("user_update", {
    ...context,
    vendorId,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    fields: Object.keys($set).sort(),
  });
  if (result.matchedCount === 0) {
    logError("user_update_no_match", { ...context, vendorId });
    throw new Error(`No user matched vendorId ${vendorId} for ${context.handler}`);
  }
  return result;
}

async function activateVendor(db, vendorId, { customerId, subscriptionId, priceId, periodEnd }, context) {
  const expiry = periodEnd instanceof Date && !Number.isNaN(periodEnd.getTime())
    ? periodEnd
    : new Date(Date.now() + FALLBACK_PERIOD_MS);
  const $set = {
    subscriptionPlan: "premium",
    subscriptionExpiresAt: expiry,
  };
  if (customerId) $set.stripeCustomerId = customerId;
  if (subscriptionId) $set.stripeSubscriptionId = subscriptionId;
  if (priceId) $set.stripePriceId = priceId;
  return updateVendorUser(db, vendorId, $set, context);
}

async function downgradeVendor(db, vendorId, context) {
  const user = await findVendorUser(db, vendorId);
  if (!user) {
    logError("downgrade_user_not_found", { ...context, vendorId });
    throw new Error(`No user matched vendorId ${vendorId} for ${context.handler}`);
  }

  await updateVendorUser(db, vendorId, {
    subscriptionPlan: "free",
    subscriptionExpiresAt: null,
  }, context);

  const limit = Number(process.env.FREE_PLAN_SERVICE_LIMIT || 3);
  const active = await db.collection("services").find({
    vendorId: user._id, isActive: { $ne: false }, status: { $ne: "Rejected" },
  }).sort({ createdAt: 1 }).toArray();
  if (active.length > limit) {
    const result = await db.collection("services").updateMany(
      { _id: { $in: active.slice(limit).map((service) => service._id) } },
      { $set: { isActive: false, updatedAt: new Date() } },
    );
    log("services_deactivated", {
      ...context,
      vendorId,
      modifiedCount: result.modifiedCount,
    });
  }
}

// A subscription that is canceled/unpaid must not lose the paid period it has
// already been charged for. Keep Premium until the stored period end passes.
async function endSubscriptionAccess(db, vendorId, periodEnd, context) {
  if (isFutureDate(periodEnd)) {
    await updateVendorUser(db, vendorId, {
      subscriptionPlan: "premium",
      subscriptionExpiresAt: periodEnd,
    }, context);
    return;
  }
  await downgradeVendor(db, vendorId, context);
}

async function saveTransaction(db, data, context) {
  const collection = db.collection("transactions");
  const sessionId = data.stripeSessionId || null;
  const invoiceId = data.stripeInvoiceId || null;
  const matchFilters = [];
  if (sessionId) matchFilters.push({ stripeSessionId: sessionId });
  if (invoiceId) matchFilters.push({ stripeInvoiceId: invoiceId }, { stripeSessionId: invoiceId });

  let existing = null;
  for (const filter of matchFilters) {
    existing = await collection.findOne(filter, { projection: { _id: 1 } });
    if (existing) break;
  }

  const base = {
    vendorId: data.vendorId,
    plan: "premium",
    subscriptionPlan: "premium",
    amount: amountInUsd(data.amountCents),
    currency: (data.currency || "usd").toLowerCase(),
    stripeSessionId: sessionId || invoiceId,
    stripeInvoiceId: invoiceId,
    stripeSubscriptionId: data.stripeSubscriptionId || null,
    status: data.status,
  };

  let action = "inserted";
  let result;
  if (existing) {
    if (data.status === "failed") {
      // A failed replay must never downgrade an already-paid transaction.
      action = "unchanged";
      result = { matchedCount: 1, modifiedCount: 0, upsertedCount: 0 };
    } else {
      const $set = {
        plan: base.plan,
        subscriptionPlan: base.subscriptionPlan,
        amount: base.amount,
        currency: base.currency,
        status: base.status,
        stripeInvoiceId: base.stripeInvoiceId,
        stripeSubscriptionId: base.stripeSubscriptionId,
        updatedAt: new Date(),
      };
      // Keep success-page polling working even if invoice.paid was processed first.
      if (sessionId) $set.stripeSessionId = sessionId;
      result = await collection.updateOne({ _id: existing._id }, { $set });
      action = result.modifiedCount > 0 ? "updated" : "unchanged";
    }
  } else {
    const filter = sessionId ? { stripeSessionId: sessionId } : { stripeInvoiceId: invoiceId };
    result = await collection.updateOne(
      filter,
      { $setOnInsert: { ...base, createdAt: data.createdAt || new Date() } },
      { upsert: true },
    );
    action = result.upsertedCount > 0 ? "inserted" : "unchanged";
  }

  log("transaction_saved", {
    ...context,
    action,
    vendorId: String(data.vendorId),
    stripeSessionId: sessionId,
    stripeInvoiceId: invoiceId,
    amount: base.amount,
    status: base.status,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    upsertedCount: result.upsertedCount,
  });
  return result;
}

async function retrieveSubscription(stripe, subscriptionId, context) {
  if (!subscriptionId) {
    log("subscription_skipped", { ...context, reason: "missing_subscription_id" });
    return null;
  }
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    log("subscription_retrieved", { ...context, subscriptionId });
    return subscription;
  } catch (error) {
    // A deleted/missing subscription is not retryable; the invoice fallback
    // may still carry the paid period. Transient errors bubble up so Stripe
    // retries the event.
    if (error?.code === "resource_missing") {
      log("subscription_missing", { ...context, subscriptionId });
      return null;
    }
    throw error;
  }
}

async function retrieveInvoice(stripe, invoiceId, context) {
  if (!invoiceId) {
    log("invoice_skipped", { ...context, reason: "missing_invoice_id" });
    return null;
  }
  try {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    log("invoice_retrieved", { ...context, invoiceId });
    return invoice;
  } catch (error) {
    if (error?.code === "resource_missing") {
      log("invoice_missing", { ...context, invoiceId });
      return null;
    }
    throw error;
  }
}

async function handleCheckoutSessionCompleted(db, stripe, event) {
  const context = { eventId: event.id, type: event.type, handler: "checkout.session.completed" };
  const session = event.data.object;
  log("handler_started", {
    ...context,
    sessionId: session?.id,
    mode: session?.mode,
    paymentStatus: session?.payment_status,
    status: session?.status,
  });

  const paid = session?.payment_status === "paid" ||
    (session?.mode === "subscription" && session?.status === "complete");
  if (!paid) {
    log("handler_skipped", { ...context, reason: "not_paid", paymentStatus: session?.payment_status });
    return false;
  }

  const vendorId = await vendorIdFromSession(db, session);
  const vendorUser = await requireVendorUser(db, vendorId, context);

  const subscriptionId = asStripeId(session.subscription);
  if (!subscriptionId) {
    log("handler_skipped", { ...context, reason: "missing_subscription" });
    return false;
  }

  const subscription = await retrieveSubscription(stripe, subscriptionId, context);
  let periodEnd = subscriptionPeriodEnd(subscription);
  if (!periodEnd) {
    const invoice = await retrieveInvoice(stripe, asStripeId(session.invoice), context);
    periodEnd = invoicePeriodEnd(invoice);
  }
  if (periodEnd) {
    log("period_end_resolved", { ...context, periodEnd: periodEnd.toISOString() });
  } else {
    periodEnd = new Date(Date.now() + FALLBACK_PERIOD_MS);
    log("period_end_fallback", { ...context, periodEnd: periodEnd.toISOString() });
  }

  await saveTransaction(db, {
    vendorId: vendorUser._id,
    amountCents: session.amount_total,
    currency: session.currency,
    status: "paid",
    stripeSessionId: session.id,
    stripeInvoiceId: asStripeId(session.invoice),
    stripeSubscriptionId: subscriptionId,
  }, context);

  await activateVendor(db, vendorId, {
    customerId: asStripeId(session.customer),
    subscriptionId,
    priceId: subscriptionPriceId(subscription),
    periodEnd,
  }, context);

  return true;
}

async function handleInvoicePaid(db, stripe, event) {
  const context = { eventId: event.id, type: event.type, handler: "invoice.paid" };
  const invoice = event.data.object;
  log("handler_started", {
    ...context,
    invoiceId: invoice?.id,
    subscriptionId: asStripeId(invoice?.subscription),
    amountPaid: invoice?.amount_paid,
  });

  const subscriptionId = asStripeId(invoice.subscription);
  if (!subscriptionId) {
    log("handler_skipped", { ...context, reason: "missing_subscription" });
    return false;
  }

  const subscription = await retrieveSubscription(stripe, subscriptionId, context);
  const vendorId = subscription
    ? await vendorIdFromSubscription(db, subscription)
    : await vendorIdFromInvoice(db, invoice);
  const vendorUser = await requireVendorUser(db, vendorId, context);

  const periodEnd = periodEndOrFallback(
    subscriptionPeriodEnd(subscription),
    invoicePeriodEnd(invoice),
  );
  log("period_end_resolved", { ...context, periodEnd: periodEnd.toISOString() });

  await saveTransaction(db, {
    vendorId: vendorUser._id,
    amountCents: typeof invoice.amount_paid === "number" ? invoice.amount_paid : invoice.amount_due,
    currency: invoice.currency,
    status: "paid",
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscriptionId,
  }, context);

  await activateVendor(db, vendorId, {
    customerId: asStripeId(invoice.customer) || asStripeId(subscription?.customer),
    subscriptionId,
    priceId: subscriptionPriceId(subscription),
    periodEnd,
  }, context);

  return true;
}

async function handleSubscriptionUpdated(db, event) {
  const context = { eventId: event.id, type: event.type, handler: "customer.subscription.updated" };
  const subscription = event.data.object;
  log("handler_started", {
    ...context,
    subscriptionId: subscription?.id,
    status: subscription?.status,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end,
  });

  const vendorId = await vendorIdFromSubscription(db, subscription);
  await requireVendorUser(db, vendorId, context);

  const periodEnd = subscriptionPeriodEnd(subscription);
  if (["canceled", "unpaid", "incomplete_expired"].includes(subscription.status)) {
    await endSubscriptionAccess(db, vendorId, periodEnd, context);
  } else {
    const expiry = periodEndOrFallback(periodEnd);
    log("period_end_resolved", { ...context, periodEnd: expiry.toISOString() });
    await activateVendor(db, vendorId, {
      customerId: asStripeId(subscription.customer),
      subscriptionId: subscription.id,
      priceId: subscriptionPriceId(subscription),
      periodEnd: expiry,
    }, context);
  }
  return true;
}

async function handleSubscriptionDeleted(db, event) {
  const context = { eventId: event.id, type: event.type, handler: "customer.subscription.deleted" };
  const subscription = event.data.object;
  log("handler_started", {
    ...context,
    subscriptionId: subscription?.id,
    status: subscription?.status,
  });

  const vendorId = await vendorIdFromSubscription(db, subscription);
  await requireVendorUser(db, vendorId, context);
  await endSubscriptionAccess(db, vendorId, subscriptionPeriodEnd(subscription), context);
  return true;
}

async function handleAsyncPaymentFailed(db, event) {
  const context = { eventId: event.id, type: event.type, handler: "checkout.session.async_payment_failed" };
  const session = event.data.object;
  log("handler_started", { ...context, sessionId: session?.id, paymentStatus: session?.payment_status });

  const vendorId = await vendorIdFromSession(db, session);
  const vendorUser = await requireVendorUser(db, vendorId, context);
  await saveTransaction(db, {
    vendorId: vendorUser._id,
    amountCents: session.amount_total,
    currency: session.currency,
    status: "failed",
    stripeSessionId: session.id,
    stripeInvoiceId: asStripeId(session.invoice),
    stripeSubscriptionId: asStripeId(session.subscription),
  }, context);
  return true;
}

async function handleInvoicePaymentFailed(db, stripe, event) {
  const context = { eventId: event.id, type: event.type, handler: "invoice.payment_failed" };
  const invoice = event.data.object;
  log("handler_started", {
    ...context,
    invoiceId: invoice?.id,
    subscriptionId: asStripeId(invoice?.subscription),
    amountDue: invoice?.amount_due,
  });

  const subscriptionId = asStripeId(invoice.subscription);
  const subscription = await retrieveSubscription(stripe, subscriptionId, context);
  const vendorId = subscription
    ? await vendorIdFromSubscription(db, subscription)
    : await vendorIdFromInvoice(db, invoice);
  const vendorUser = await requireVendorUser(db, vendorId, context);

  await saveTransaction(db, {
    vendorId: vendorUser._id,
    amountCents: typeof invoice.amount_due === "number" ? invoice.amount_due : invoice.amount_paid,
    currency: invoice.currency,
    status: "failed",
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscriptionId,
  }, context);
  return true;
}

export async function processStripeEvent(event, { db, stripe }) {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(db, stripe, event);
    case "invoice.paid":
      return handleInvoicePaid(db, stripe, event);
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(db, event);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(db, event);
    case "checkout.session.async_payment_failed":
      return handleAsyncPaymentFailed(db, event);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(db, stripe, event);
    default:
      log("event_ignored", { eventId: event.id, type: event.type });
      return false;
  }
}

router.post("/", async (req, res) => {
  log("incoming_request", {
    contentType: req.headers["content-type"] || null,
    hasSignature: Boolean(req.headers["stripe-signature"]),
    bodyIsBuffer: Buffer.isBuffer(req.body),
    bodyLength: Buffer.isBuffer(req.body) ? req.body.length : null,
  });

  if (!Buffer.isBuffer(req.body)) {
    logError("raw_body_missing", { bodyType: typeof req.body });
    return res.status(400).json({ success: false, message: "Stripe webhook requires a raw body." });
  }

  try {
    await connectDB();
  } catch (error) {
    logError("database_connection_failed", { error: error?.message || String(error) });
    return res.status(500).json({ success: false, message: "Something went wrong on the server." });
  }

  let stripe;
  try {
    stripe = getStripe();
  } catch (error) {
    logError("stripe_client_failed", { error: error?.message || String(error) });
    return res.status(500).json({ success: false, message: "Stripe is not configured." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    logError("signature_failed", { error: error?.message || String(error) });
    return res.status(400).json({ success: false, message: "Invalid Stripe webhook signature." });
  }

  log("event_received", { eventId: event.id, type: event.type });
  log("signature_verified", { eventId: event.id, type: event.type });

  try {
    const handled = await processStripeEvent(event, { db: getDb(), stripe });
    if (!handled) log("event_not_handled", { eventId: event.id, type: event.type });
  } catch (error) {
    // Return 500 so Stripe retries transient failures. Processing is
    // idempotent, so a retried event cannot duplicate payment history.
    logError("processing_failed", {
      eventId: event.id,
      type: event.type,
      error: error?.message || String(error),
    });
    return res.status(500).json({ success: false, message: "Webhook processing failed." });
  }

  return res.status(200).json({ success: true, message: "Webhook received.", data: { received: true } });
});

export default router;
