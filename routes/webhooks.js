import { Router } from "express";
import Stripe from "stripe";
import { connectDB, getDb } from "../db.js";
import { toObjectId } from "../helpers.js";

const router = Router();

export function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

async function downgradeVendor(db, vendorId) {
  if (!vendorId) return;
  const users = db.collection(process.env.USERS_COLLECTION || "user");
  await users.updateOne(
    { _id: vendorId },
    { $set: { subscriptionPlan: "free", updatedAt: new Date() } },
  );
  const limit = Number(process.env.FREE_PLAN_SERVICE_LIMIT || 3);
  const active = await db.collection("services").find({
    vendorId, isActive: true, status: { $ne: "rejected" },
  }).sort({ createdAt: 1 }).toArray();
  if (active.length > limit) {
    await db.collection("services").updateMany(
      { _id: { $in: active.slice(limit).map((service) => service._id) } },
      { $set: { isActive: false, updatedAt: new Date() } },
    );
  }
}

async function vendorIdFromSession(db, session) {
  let vendorId = session?.metadata?.vendorId;
  if (!vendorId && session?.client_reference_id) vendorId = session.client_reference_id;
  return toObjectId(vendorId);
}

async function vendorIdFromSubscription(db, subscription) {
  let vendorId = subscription?.metadata?.vendorId;
  if (!vendorId && subscription?.customer) {
    const user = await db.collection(process.env.USERS_COLLECTION || "user").findOne({ stripeCustomerId: String(subscription.customer) });
    if (user) return user._id;
  }
  return toObjectId(vendorId);
}

function subscriptionPeriodEnd(subscription) {
  const timestamp = subscription?.current_period_end ||
    subscription?.items?.data?.[0]?.current_period_end;
  return timestamp ? new Date(timestamp * 1000) : null;
}

router.post("/", async (req, res) => {
  try {
    await connectDB();
  } catch (error) {
    return res.status(500).json({ success: false, message: "Something went wrong on the server." });
  }
  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).json({ success: false, message: "Invalid Stripe webhook signature." });
  }

  try {
    const db = getDb();
    const users = db.collection(process.env.USERS_COLLECTION || "user");

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        const vendorId = await vendorIdFromSession(db, session);
        if (vendorId) {
          await db.collection("transactions").updateOne(
            { stripeSessionId: session.id },
            { $setOnInsert: {
              vendorId,
              plan: "premium",
              amount: typeof session.amount_total === "number" ? session.amount_total / 100 : 0,
              currency: (session.currency || "usd").toLowerCase(),
              stripeSessionId: session.id,
              stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
              status: "paid",
              createdAt: new Date(),
            } },
            { upsert: true },
          );
          if (session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const periodEnd = subscriptionPeriodEnd(subscription);
            await users.updateOne(
              { _id: vendorId },
              { $set: {
                subscriptionPlan: "premium",
                subscriptionExpiresAt: periodEnd,
                stripeCustomerId: typeof session.customer === "string" ? session.customer : null,
                stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
                updatedAt: new Date(),
              } },
            );
          }
        }
      }
    } else if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : null;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const vendorId = await vendorIdFromSubscription(db, subscription);
        const periodEnd = subscriptionPeriodEnd(subscription);
        if (vendorId) {
          await users.updateOne({ _id: vendorId }, { $set: {
            subscriptionPlan: "premium",
            subscriptionExpiresAt: periodEnd,
            stripeSubscriptionId: subscriptionId,
            updatedAt: new Date(),
          } });
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const vendorId = await vendorIdFromSubscription(db, subscription);
      if (vendorId) {
        if (["canceled", "unpaid", "incomplete_expired"].includes(subscription.status)) {
          await downgradeVendor(db, vendorId);
        } else {
          await users.updateOne({ _id: vendorId }, { $set: {
            subscriptionPlan: "premium",
            subscriptionExpiresAt: subscriptionPeriodEnd(subscription),
            stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : null,
            stripeSubscriptionId: subscription.id,
            updatedAt: new Date(),
          } });
        }
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const vendorId = await vendorIdFromSubscription(db, subscription);
      if (vendorId) await downgradeVendor(db, vendorId);
    } else if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      const vendorId = await vendorIdFromSession(db, session);
      if (vendorId) {
        await db.collection("transactions").updateOne(
          { stripeSessionId: session.id },
          { $setOnInsert: {
            vendorId, plan: "premium", amount: typeof session.amount_total === "number" ? session.amount_total / 100 : 0,
            currency: (session.currency || "usd").toLowerCase(),
            stripeSessionId: session.id, stripeSubscriptionId: null, status: "failed", createdAt: new Date(),
          } },
          { upsert: true },
        );
      }
    } else if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : null;
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const vendorId = await vendorIdFromSubscription(db, subscription);
        if (vendorId) {
          await db.collection("transactions").updateOne(
            { stripeSessionId: invoice.id },
            { $setOnInsert: {
              vendorId, plan: "premium", amount: typeof invoice.amount_due === "number" ? invoice.amount_due / 100 : 0,
              currency: (invoice.currency || "usd").toLowerCase(),
              stripeSessionId: invoice.id, stripeSubscriptionId: subscriptionId, status: "failed", createdAt: new Date(),
            } },
            { upsert: true },
          );
        }
      }
    }
  } catch (error) {
    console.error(error?.message || error);
  }
  return res.status(200).json({ success: true, message: "Webhook received.", data: { received: true } });
});

export default router;
