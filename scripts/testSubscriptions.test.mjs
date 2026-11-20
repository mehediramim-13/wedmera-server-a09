import "dotenv/config";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { ObjectId } from "mongodb";

const TEST_DB = `wm_subs_test_${Date.now().toString(36)}`;
process.env.DB_NAME = TEST_DB;
process.env.VERCEL = "1";

// A local JWKS lets the API verify the test JWTs exactly as it verifies
// Better Auth tokens in development.
const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  crv: "Ed25519",
  extractable: true,
});
const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "EdDSA", use: "sig" };
const jwksServer = http.createServer((req, res) => {
  if (req.url !== "/jwks") return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ keys: [jwk] }));
});
jwksServer.listen(0, "127.0.0.1");
await once(jwksServer, "listening");
process.env.JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/jwks`;

const { default: app } = await import("../index.js");
const { connectDB, getDb, initDatabase, closeDB } = await import("../db.js");
const { processStripeEvent } = await import("../routes/webhooks.js");
const { countActiveServices } = await import("../helpers.js");

await connectDB();
await initDatabase();
const db = getDb();
const users = db.collection(process.env.USERS_COLLECTION || "user");
const transactions = db.collection("transactions");

const apiServer = app.listen(0, "127.0.0.1");
await once(apiServer, "listening");
const base = `http://127.0.0.1:${apiServer.address().port}`;

const futureSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
const periodStartSec = futureSec - 30 * 24 * 60 * 60;
const subscriptions = new Map();
const fakeStripe = {
  subscriptions: {
    retrieve: async (id) => {
      const subscription = subscriptions.get(id);
      if (!subscription) {
        const error = new Error(`No such subscription: ${id}`);
        error.code = "resource_missing";
        throw error;
      }
      return subscription;
    },
  },
  invoices: {
    retrieve: async (id) => {
      const error = new Error(`No such invoice: ${id}`);
      error.code = "resource_missing";
      throw error;
    },
  },
};

function subscriptionFor(vendorId, id, customer, periodEnd = futureSec) {
  const start = Number.isFinite(periodEnd) ? periodEnd - 30 * 24 * 60 * 60 : undefined;
  return {
    id,
    customer,
    status: "active",
    current_period_start: start,
    current_period_end: periodEnd,
    items: { data: [{
      current_period_start: start,
      current_period_end: periodEnd,
      price: { id: "price_test_49" },
    }] },
    metadata: { vendorId: String(vendorId) },
  };
}

async function createVendor(label, { stringId = false } = {}) {
  const objectId = new ObjectId();
  const _id = stringId ? objectId.toHexString() : objectId;
  const email = `${label}.${Date.now()}.${Math.random().toString(16).slice(2)}@example.com`;
  const user = {
    _id,
    email,
    name: label,
    role: "vendor",
    isBlocked: false,
    subscriptionPlan: "free",
    subscriptionExpiresAt: null,
  };
  if (!stringId) user.id = String(objectId);
  await users.insertOne(user);
  const token = await new SignJWT({ id: String(_id), email })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .setSubject(String(_id))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
  return { user, token };
}

async function getJson(path, token) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return {
    status: res.status,
    body: await res.json(),
    cacheControl: res.headers.get("cache-control"),
  };
}

const checkoutEvent = (vendorId, {
  sessionId,
  subscriptionId,
  invoiceId,
  paymentStatus = "paid",
  amount = 4900,
  customer = `cus_${vendorId}`,
}) => ({
  id: `evt_${sessionId}`,
  type: "checkout.session.completed",
  data: {
    object: {
      id: sessionId,
      object: "checkout.session",
      payment_status: paymentStatus,
      amount_total: amount,
      currency: "usd",
      customer,
      subscription: subscriptionId,
      invoice: invoiceId,
      client_reference_id: String(vendorId),
      metadata: { vendorId: String(vendorId), plan: "premium" },
    },
  },
});

const invoicePaidEvent = (invoiceId, subscriptionId, customer, amount = 4900) => ({
  id: `evt_${invoiceId}`,
  type: "invoice.paid",
  data: {
    object: {
      id: invoiceId,
      object: "invoice",
      subscription: subscriptionId,
      customer,
      amount_paid: amount,
      amount_due: amount,
      currency: "usd",
      period_end: futureSec,
      lines: { data: [{ period: { start: periodStartSec, end: futureSec } }] },
    },
  },
});

const invoiceFailedEvent = (invoiceId, subscriptionId, customer, amount = 4900) => ({
  id: `evt_${invoiceId}`,
  type: "invoice.payment_failed",
  data: {
    object: {
      id: invoiceId,
      object: "invoice",
      subscription: subscriptionId,
      customer,
      amount_due: amount,
      amount_paid: 0,
      currency: "usd",
    },
  },
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
  jwksServer.close();
  await db.dropDatabase();
  await closeDB();
});

test("Stripe subscriptions activate Premium only from confirmed webhooks and expose vendor-scoped history", async (t) => {
  const vendorA = await createVendor("Vendor A");
  const vendorB = await createVendor("Vendor B");
  const vendorC = await createVendor("Vendor C");
  const vendorD = await createVendor("Vendor D", { stringId: true });
  const vendorE = await createVendor("Vendor E");

  subscriptions.set("sub_test_a", subscriptionFor(vendorA.user._id, "sub_test_a", "cus_a"));
  subscriptions.set("sub_test_b", subscriptionFor(vendorB.user._id, "sub_test_b", "cus_b"));
  subscriptions.set("sub_test_c", subscriptionFor(vendorC.user._id, "sub_test_c", "cus_c"));
  subscriptions.set("sub_test_d", subscriptionFor(vendorD.user._id, "sub_test_d", "cus_d"));
  subscriptions.set("sub_test_e", {
    ...subscriptionFor(vendorE.user._id, "sub_test_e", "cus_e"),
    current_period_start: undefined,
    current_period_end: undefined,
    items: { data: [{ price: { id: "price_test_49" } }] },
  });

  await t.test("rejects webhook requests with an invalid signature", async () => {
    const res = await fetch(`${base}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify(checkoutEvent(vendorA.user._id, {
        sessionId: "cs_bad_signature",
        subscriptionId: "sub_test_a",
        invoiceId: "in_bad_signature",
      })),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /Invalid Stripe webhook signature/);

    const user = await users.findOne({ _id: vendorA.user._id });
    assert.equal(user.subscriptionPlan, "free");
  });

  await t.test("accepts a correctly signed webhook event", async () => {
    const payload = JSON.stringify({
      id: "evt_valid_signature",
      type: "customer.created",
      data: { object: { id: "cus_signature_check" } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    const res = await fetch(`${base}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  await t.test("activates Premium and records payment on a paid checkout webhook", async () => {
    await processStripeEvent(
      checkoutEvent(vendorA.user._id, {
        sessionId: "cs_test_a",
        subscriptionId: "sub_test_a",
        invoiceId: "in_test_a",
        customer: "cus_a",
      }),
      { db, stripe: fakeStripe },
    );

    const user = await users.findOne({ _id: vendorA.user._id });
    assert.equal(user.subscriptionPlan, "premium");
    assert.equal(user.plan, "premium");
    assert.equal(user.status, "active");
    assert.equal(user.cancelAtPeriodEnd, false);
    assert.ok(user.currentPeriodStart instanceof Date);
    assert.equal(user.currentPeriodStart.getTime(), periodStartSec * 1000);
    assert.ok(user.currentPeriodEnd instanceof Date);
    assert.equal(user.currentPeriodEnd.getTime(), futureSec * 1000);
    assert.ok(user.subscriptionExpiresAt instanceof Date);
    assert.ok(user.subscriptionExpiresAt.getTime() > Date.now());
    assert.equal(user.stripeCustomerId, "cus_a");
    assert.equal(user.stripeSubscriptionId, "sub_test_a");
    assert.equal(user.stripePriceId, "price_test_49");

    const history = await transactions.find({ vendorId: vendorA.user._id }).toArray();
    assert.equal(history.length, 1);
    assert.equal(history[0].stripeSessionId, "cs_test_a");
    assert.equal(history[0].stripeInvoiceId, "in_test_a");
    assert.equal(history[0].amount, 49);
    assert.equal(history[0].status, "paid");
    assert.equal(history[0].plan, "premium");
    assert.ok(history[0].periodStart instanceof Date);
    assert.equal(history[0].periodStart.getTime(), periodStartSec * 1000);
    assert.ok(history[0].periodEnd instanceof Date);
    assert.equal(history[0].periodEnd.getTime(), futureSec * 1000);
  });

  await t.test("matches vendors whose Better Auth _id is a string and has no id field", async () => {
    await processStripeEvent(
      checkoutEvent(vendorD.user._id, {
        sessionId: "cs_test_d",
        subscriptionId: "sub_test_d",
        invoiceId: "in_test_d",
        customer: "cus_d",
      }),
      { db, stripe: fakeStripe },
    );

    const userD = await users.findOne({ _id: vendorD.user._id });
    assert.equal(typeof userD._id, "string");
    assert.equal(userD.id, undefined);
    assert.equal(userD.subscriptionPlan, "premium");
    assert.ok(userD.subscriptionExpiresAt instanceof Date);

    const historyD = await transactions.find({ vendorId: vendorD.user._id }).toArray();
    assert.equal(historyD.length, 1);
    assert.equal(historyD[0].status, "paid");
  });

  await t.test("does not invent period dates when Stripe does not provide them", async () => {
    await processStripeEvent(
      checkoutEvent(vendorE.user._id, {
        sessionId: "cs_test_e",
        subscriptionId: "sub_test_e",
        invoiceId: "in_test_e",
        customer: "cus_e",
      }),
      { db, stripe: fakeStripe },
    );

    const userE = await users.findOne({ _id: vendorE.user._id });
    assert.equal(userE.subscriptionPlan, "free");
    assert.equal(userE.currentPeriodStart, null);
    assert.equal(userE.currentPeriodEnd, null);

    const historyE = await transactions.find({ vendorId: vendorE.user._id }).toArray();
    assert.equal(historyE.length, 1);
    assert.equal(historyE[0].periodStart, null);
    assert.equal(historyE[0].periodEnd, null);

    const subscription = await getJson("/api/vendor/subscription", vendorE.token);
    assert.equal(subscription.body.data.plan, "free");
    assert.equal(subscription.body.data.currentPeriodStart, null);
    assert.equal(subscription.body.data.currentPeriodEnd, null);
  });

  await t.test("reads current_period_end from subscription items before the top-level field", async () => {
    const vendorG = await createVendor("Vendor G");
    const itemEndSec = Math.floor(Date.now() / 1000) + 25 * 24 * 60 * 60;
    const itemOnlySubscription = {
      ...subscriptionFor(vendorG.user._id, "sub_test_g", "cus_g"),
      current_period_start: undefined,
      current_period_end: undefined,
      items: { data: [{
        current_period_start: itemEndSec - 30 * 24 * 60 * 60,
        current_period_end: itemEndSec,
        price: { id: "price_test_49" },
      }] },
    };
    subscriptions.set("sub_test_g", itemOnlySubscription);

    await processStripeEvent(
      checkoutEvent(vendorG.user._id, {
        sessionId: "cs_test_g",
        subscriptionId: "sub_test_g",
        invoiceId: "in_test_g",
        customer: "cus_g",
      }),
      { db, stripe: fakeStripe },
    );

    let userG = await users.findOne({ _id: vendorG.user._id });
    assert.equal(userG.plan, "premium");
    assert.equal(userG.status, "active");
    assert.equal(userG.cancelAtPeriodEnd, false);
    assert.equal(userG.currentPeriodStart.getTime(), (itemEndSec - 30 * 24 * 60 * 60) * 1000);
    assert.equal(userG.currentPeriodEnd.getTime(), itemEndSec * 1000);

    await processStripeEvent({
      id: "evt_sub_g_cancel_scheduled",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...itemOnlySubscription,
          status: "active",
          cancel_at_period_end: true,
        },
      },
    }, { db, stripe: fakeStripe });

    userG = await users.findOne({ _id: vendorG.user._id });
    assert.equal(userG.plan, "premium");
    assert.equal(userG.subscriptionPlan, "premium");
    assert.equal(userG.status, "active");
    assert.equal(userG.subscriptionStatus, "active");
    assert.equal(userG.cancelAtPeriodEnd, true);
    assert.equal(userG.isPremium, true);
    assert.equal(userG.isFeatured, true);
    assert.equal(userG.currentPeriodEnd.getTime(), itemEndSec * 1000);
  });

  await t.test("keeps payment history idempotent on event and invoice replays", async () => {
    const event = checkoutEvent(vendorA.user._id, {
      sessionId: "cs_test_a",
      subscriptionId: "sub_test_a",
      invoiceId: "in_test_a",
      customer: "cus_a",
    });
    await processStripeEvent(event, { db, stripe: fakeStripe });
    await processStripeEvent(event, { db, stripe: fakeStripe });
    await processStripeEvent(invoicePaidEvent("in_test_a", "sub_test_a", "cus_a"), { db, stripe: fakeStripe });
    await processStripeEvent(invoicePaidEvent("in_test_a", "sub_test_a", "cus_a"), { db, stripe: fakeStripe });

    const history = await transactions.find({ vendorId: vendorA.user._id }).toArray();
    assert.equal(history.length, 1);
    assert.equal(history[0].stripeSessionId, "cs_test_a");
    assert.equal(history[0].stripeInvoiceId, "in_test_a");
    assert.equal(history[0].status, "paid");
    assert.equal(history[0].amount, 49);
  });

  await t.test("does not activate Premium for unpaid or failed payments", async () => {
    await processStripeEvent(
      checkoutEvent(vendorB.user._id, {
        sessionId: "cs_test_b_unpaid",
        subscriptionId: "sub_test_b",
        invoiceId: "in_test_b_unpaid",
        paymentStatus: "unpaid",
        customer: "cus_b",
      }),
      { db, stripe: fakeStripe },
    );
    let userB = await users.findOne({ _id: vendorB.user._id });
    assert.equal(userB.subscriptionPlan, "free");
    assert.equal(await transactions.countDocuments({ vendorId: vendorB.user._id }), 0);

    await processStripeEvent(
      invoiceFailedEvent("in_test_b_failed", "sub_test_b", "cus_b"),
      { db, stripe: fakeStripe },
    );
    userB = await users.findOne({ _id: vendorB.user._id });
    assert.equal(userB.subscriptionPlan, "free");

    const history = await transactions.find({ vendorId: vendorB.user._id }).toArray();
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "failed");
    assert.equal(history[0].amount, 49);
  });

  await t.test("keeps Premium but marks it cancelling until the paid period ends", async () => {
    await processStripeEvent(
      checkoutEvent(vendorC.user._id, {
        sessionId: "cs_test_c",
        subscriptionId: "sub_test_c",
        invoiceId: "in_test_c",
        customer: "cus_c",
      }),
      { db, stripe: fakeStripe },
    );

    await processStripeEvent({
      id: "evt_sub_c_cancel_scheduled",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...subscriptionFor(vendorC.user._id, "sub_test_c", "cus_c"),
          status: "active",
          cancel_at_period_end: true,
        },
      },
    }, { db, stripe: fakeStripe });

    const userC = await users.findOne({ _id: vendorC.user._id });
    assert.equal(userC.plan, "premium");
    assert.equal(userC.subscriptionPlan, "premium");
    assert.equal(userC.status, "active");
    assert.equal(userC.subscriptionStatus, "active");
    assert.equal(userC.cancelAtPeriodEnd, true);
    assert.equal(userC.isPremium, true);
    assert.equal(userC.isFeatured, true);
    assert.ok(userC.currentPeriodEnd.getTime() > Date.now());

    const subscription = await getJson("/api/vendor/subscription", vendorC.token);
    assert.equal(subscription.body.data.plan, "premium");
    assert.equal(subscription.body.data.status, "cancelling");
    assert.equal(subscription.body.data.subscriptionStatus, "active");
    assert.equal(subscription.body.data.cancelAtPeriodEnd, true);
  });

  await t.test("reverts to Free immediately on subscription deletion and trims active services", async () => {
    const now = Date.now();
    await db.collection("services").insertMany(
      [0, 1, 2, 3, 4].map((index) => ({
        vendorId: vendorC.user._id,
        serviceName: `C service ${index}`,
        status: "Approved",
        isActive: true,
        createdAt: new Date(now - (5 - index) * 60_000),
      })),
    );

    await processStripeEvent({
      id: "evt_sub_c_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          ...subscriptionFor(vendorC.user._id, "sub_test_c", "cus_c", Math.floor(Date.now() / 1000) - 60),
          status: "canceled",
        },
      },
    }, { db, stripe: fakeStripe });

    const userC = await users.findOne({ _id: vendorC.user._id });
    assert.equal(userC.plan, "free");
    assert.equal(userC.subscriptionPlan, "free");
    assert.equal(userC.status, "canceled");
    assert.equal(userC.subscriptionStatus, "canceled");
    assert.equal(userC.cancelAtPeriodEnd, false);
    assert.equal(userC.currentPeriodEnd, null);
    assert.equal(userC.subscriptionExpiresAt, null);
    assert.equal(userC.isPremium, false);
    assert.equal(userC.isFeatured, false);
    assert.equal(userC.stripeSubscriptionId, null);

    const history = await transactions.find({ vendorId: vendorC.user._id }).toArray();
    assert.equal(history.length, 1, "downgrade must not modify payment history");
    assert.equal(history[0].status, "paid");
    assert.equal(history[0].amount, 49);

    const services = await db.collection("services").find({ vendorId: vendorC.user._id }).toArray();
    assert.equal(services.length, 5, "downgrade must not delete services");
    assert.equal(services.filter((service) => service.isActive).length, 3);
    assert.equal(services.filter((service) => service.isActive === false).length, 2);

    const subscription = await getJson("/api/vendor/subscription", vendorC.token);
    assert.equal(subscription.body.data.plan, "free");
    assert.equal(subscription.body.data.subscriptionPlan, "free");
    assert.equal(subscription.body.data.status, "canceled");
    assert.equal(subscription.body.data.subscriptionStatus, "canceled");
    assert.equal(subscription.body.data.cancelAtPeriodEnd, false);
    assert.equal(subscription.body.data.currentPeriodEnd, null);
    assert.equal(subscription.body.data.expiresAt, null);
    assert.equal(subscription.body.data.isPremium, false);
    assert.equal(subscription.body.data.isFeatured, false);

    const featured = await getJson("/api/services?featured=true");
    assert.equal(featured.status, 200);
    assert.equal(featured.body.data.items.some(
      (item) => String(item.vendorId) === String(vendorC.user._id),
    ), false, "downgraded vendor must lose featured placement");
  });

  await t.test("deletion uses stripeSubscriptionId when metadata points to another vendor", async () => {
    const vendor = await createVendor("Vendor Delete By Subscription");
    const staleVendor = await createVendor("Vendor Stale Metadata");
    const subscriptionId = "sub_test_delete_by_subscription";
    subscriptions.set(subscriptionId, subscriptionFor(vendor.user._id, subscriptionId, "cus_delete_by_sub"));

    await processStripeEvent(
      checkoutEvent(vendor.user._id, {
        sessionId: "cs_delete_by_sub",
        subscriptionId,
        invoiceId: "in_delete_by_sub",
        customer: "cus_delete_by_sub",
      }),
      { db, stripe: fakeStripe },
    );

    // Force lookup through stripeSubscriptionId; metadata deliberately points
    // at a different user, which used to abort the downgrade.
    await users.updateOne({ _id: vendor.user._id }, { $unset: { stripeCustomerId: "" } });
    await processStripeEvent({
      id: "evt_delete_stale_metadata",
      type: "customer.subscription.deleted",
      data: { object: { ...subscriptionFor(staleVendor.user._id, subscriptionId, "cus_delete_by_sub"), status: "canceled" } },
    }, { db, stripe: fakeStripe });

    const updated = await users.findOne({ _id: vendor.user._id });
    assert.equal(updated.plan, "free");
    assert.equal(updated.subscriptionPlan, "free");
    assert.equal(updated.status, "canceled");
    assert.equal(updated.subscriptionStatus, "canceled");
    assert.equal(updated.cancelAtPeriodEnd, false);
    assert.equal(updated.currentPeriodEnd, null);
    assert.equal(updated.isPremium, false);
    assert.equal(updated.isFeatured, false);

    const untouched = await users.findOne({ _id: staleVendor.user._id });
    assert.equal(untouched.subscriptionPlan, "free");
  });

  await t.test("deletion falls back to transaction history for legacy vendors without Stripe ID fields", async () => {
    const vendor = await createVendor("Vendor Delete By Transaction");
    const subscriptionId = "sub_test_delete_by_transaction";
    subscriptions.set(subscriptionId, subscriptionFor(vendor.user._id, subscriptionId, "cus_delete_by_tx"));

    await processStripeEvent(
      checkoutEvent(vendor.user._id, {
        sessionId: "cs_delete_by_tx",
        subscriptionId,
        invoiceId: "in_delete_by_tx",
        customer: "cus_delete_by_tx",
      }),
      { db, stripe: fakeStripe },
    );

    const transaction = await transactions.findOne({ vendorId: vendor.user._id, stripeSubscriptionId: subscriptionId });
    assert.ok(transaction, "checkout must record the Stripe subscription ID in history");

    const legacySubscription = subscriptionFor(vendor.user._id, subscriptionId, "cus_delete_by_tx");
    delete legacySubscription.metadata;
    await users.updateOne(
      { _id: vendor.user._id },
      { $unset: { stripeCustomerId: "", stripeSubscriptionId: "" } },
    );

    await processStripeEvent({
      id: "evt_delete_legacy_missing_ids",
      type: "customer.subscription.deleted",
      data: { object: { ...legacySubscription, status: "canceled" } },
    }, { db, stripe: fakeStripe });

    const updated = await users.findOne({ _id: vendor.user._id });
    assert.equal(updated.plan, "free");
    assert.equal(updated.subscriptionPlan, "free");
    assert.equal(updated.status, "canceled");
    assert.equal(updated.subscriptionStatus, "canceled");
    assert.equal(updated.cancelAtPeriodEnd, false);
    assert.equal(updated.currentPeriodEnd, null);
    assert.equal(updated.isPremium, false);
    assert.equal(updated.isFeatured, false);

    const transactionAfter = await transactions.findOne({ _id: transaction._id });
    assert.equal(transactionAfter.status, "paid");
    assert.equal(transactionAfter.amount, 49);
    assert.equal(transactionAfter.stripeSubscriptionId, subscriptionId);
  });

  await t.test("downgrades immediately when a subscription becomes unpaid", async () => {
    const vendorF = await createVendor("Vendor F");
    subscriptions.set("sub_test_f", subscriptionFor(vendorF.user._id, "sub_test_f", "cus_f"));
    await processStripeEvent(
      checkoutEvent(vendorF.user._id, {
        sessionId: "cs_test_f",
        subscriptionId: "sub_test_f",
        invoiceId: "in_test_f",
        customer: "cus_f",
      }),
      { db, stripe: fakeStripe },
    );

    await processStripeEvent({
      id: "evt_sub_f_unpaid",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...subscriptionFor(vendorF.user._id, "sub_test_f", "cus_f"),
          status: "unpaid",
        },
      },
    }, { db, stripe: fakeStripe });

    const userF = await users.findOne({ _id: vendorF.user._id });
    assert.equal(userF.plan, "free");
    assert.equal(userF.subscriptionPlan, "free");
    assert.equal(userF.status, "unpaid");
    assert.equal(userF.subscriptionStatus, "unpaid");
    assert.equal(userF.cancelAtPeriodEnd, false);
    assert.equal(userF.currentPeriodEnd, null);
    assert.equal(userF.isPremium, false);
    assert.equal(userF.isFeatured, false);

    const subscription = await getJson("/api/vendor/subscription", vendorF.token);
    assert.equal(subscription.body.data.plan, "free");
    assert.equal(subscription.body.data.status, "unpaid");
    assert.equal(subscription.body.data.cancelAtPeriodEnd, false);
    assert.equal(subscription.body.data.currentPeriodEnd, null);
  });

  await t.test("does not reapply an older event when the same event ID is replayed", async () => {
    const before = await users.findOne({ _id: vendorC.user._id });
    assert.equal(before.plan, "free");

    const event = checkoutEvent(vendorC.user._id, {
      sessionId: "cs_test_c",
      subscriptionId: "sub_test_c",
      invoiceId: "in_test_c",
      customer: "cus_c",
    });
    await processStripeEvent(event, { db, stripe: fakeStripe });
    await processStripeEvent(event, { db, stripe: fakeStripe });

    const after = await users.findOne({ _id: vendorC.user._id });
    assert.equal(after.plan, "free");
    assert.equal(after.status, "canceled");
  });

  await t.test("returns the persisted plan from subscription and profile endpoints", async () => {
    const subscription = await getJson("/api/vendor/subscription", vendorA.token);
    assert.equal(subscription.status, 200);
    assert.equal(subscription.body.data.plan, "premium");
    assert.equal(subscription.body.data.subscriptionPlan, "premium");
    assert.equal(subscription.body.data.currentPlan, "premium");
    assert.equal(subscription.body.data.effectivePlan, "premium");
    assert.equal(subscription.body.data.status, "active");
    assert.equal(subscription.body.data.subscriptionStatus, "active");
    assert.equal(subscription.body.data.isPremium, true);
    assert.equal(subscription.body.data.isFeatured, true);
    assert.equal(typeof subscription.body.data.cancelAtPeriodEnd, "boolean");
    assert.equal(subscription.body.data.cancelAtPeriodEnd, false);
    assert.equal(subscription.body.data.currentPeriodStart, new Date(periodStartSec * 1000).toISOString());
    assert.equal(subscription.body.data.currentPeriodEnd, new Date(futureSec * 1000).toISOString());
    assert.equal(typeof subscription.body.data.currentPeriodEnd, "string");
    assert.ok(!Number.isNaN(Date.parse(subscription.body.data.currentPeriodEnd)));
    assert.equal(subscription.body.data.currentPeriodEnd, subscription.body.data.expiresAt);
    assert.ok(subscription.body.data.expiresAt);

    const me = await getJson("/api/users/me", vendorA.token);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.subscriptionPlan, "premium");
    assert.equal(me.body.data.effectivePlan, "premium");
    assert.ok(me.body.data.subscriptionExpiresAt);

    const overview = await getJson("/api/vendor/overview", vendorA.token);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.data.plan, "premium");
    assert.equal(overview.body.data.currentPlan, "premium");
    assert.equal(overview.body.data.effectivePlan, "premium");
    assert.ok(overview.body.data.subscriptionExpiresAt);

    const freeSubscription = await getJson("/api/vendor/subscription", vendorB.token);
    assert.equal(freeSubscription.body.data.plan, "free");
    assert.equal(freeSubscription.body.data.subscriptionPlan, "free");
    assert.equal(freeSubscription.body.data.cancelAtPeriodEnd, false);
    assert.equal(freeSubscription.body.data.currentPeriodStart, null);
    assert.equal(freeSubscription.body.data.currentPeriodEnd, null);
  });

  await t.test("exposes a resume endpoint that rejects vendors without a Stripe subscription", async () => {
    const res = await fetch(`${base}/api/vendor/subscription/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${vendorB.token}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  await t.test("treats an active status with a past currentPeriodEnd as Free", async () => {
    const vendorH = await createVendor("Vendor H");
    const expired = new Date(Date.now() - 60_000);
    await users.updateOne({ _id: vendorH.user._id }, {
      $set: {
        plan: "premium",
        subscriptionPlan: "premium",
        status: "active",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
        currentPeriodStart: expired,
        currentPeriodEnd: expired,
        subscriptionExpiresAt: expired,
        isPremium: true,
        isFeatured: true,
      },
    });

    const res = await getJson("/api/vendor/subscription", vendorH.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.plan, "free");
    assert.equal(res.body.data.subscriptionPlan, "free");
    assert.equal(res.body.data.status, "expired");
    assert.equal(res.body.data.currentPeriodStart, null);
    assert.equal(res.body.data.currentPeriodEnd, null);
    assert.equal(res.body.data.isPremium, false);
    assert.equal(res.body.data.isFeatured, false);
  });

  await t.test("returns the saved checkout transaction to its owner only", async () => {
    const owner = await getJson("/api/payments/session/cs_test_a", vendorA.token);
    assert.equal(owner.status, 200);
    assert.equal(owner.cacheControl, "no-store");
    assert.equal(owner.body.success, true);
    assert.equal(owner.body.data.status, "paid");
    assert.ok(owner.body.data.transaction);
    assert.equal(String(owner.body.data.transaction.vendorId), String(vendorA.user._id));
    assert.equal(owner.body.data.transaction.plan, "premium");
    assert.equal(owner.body.data.transaction.amount, 49);
    assert.equal(owner.body.data.transaction.status, "paid");

    const otherVendor = await getJson("/api/payments/session/cs_test_a", vendorB.token);
    assert.equal(otherVendor.status, 200);
    assert.equal(otherVendor.cacheControl, "no-store");
    assert.equal(otherVendor.body.data.status, "processing");
    assert.equal(otherVendor.body.data.transaction, undefined);

    const missing = await getJson("/api/payments/session/cs_missing", vendorA.token);
    assert.equal(missing.status, 200);
    assert.equal(missing.cacheControl, "no-store");
    assert.equal(missing.body.data.status, "processing");
  });

  await t.test("returns only the signed-in vendor's transaction history", async () => {
    const historyA = await getJson("/api/vendor/transactions", vendorA.token);
    assert.equal(historyA.status, 200);
    assert.ok(Array.isArray(historyA.body.data));
    assert.equal(historyA.body.data.length, 1);
    const recordA = historyA.body.data[0];
    assert.ok(recordA._id || recordA.id);
    assert.equal(recordA.plan, "premium");
    assert.equal(recordA.subscriptionPlan, "premium");
    assert.equal(recordA.amount, 49);
    assert.equal(typeof recordA.amount, "number");
    assert.equal(recordA.status, "paid");
    assert.equal(recordA.periodStart, new Date(periodStartSec * 1000).toISOString());
    assert.equal(recordA.periodEnd, new Date(futureSec * 1000).toISOString());
    assert.ok(recordA.createdAt || recordA.date);

    const historyB = await getJson("/api/vendor/transactions", vendorB.token);
    assert.equal(historyB.status, 200);
    assert.equal(historyB.body.data.length, 1);
    assert.equal(historyB.body.data[0].status, "failed");
    assert.notEqual(String(historyB.body.data[0]._id), String(recordA._id));

    const unauthenticated = await getJson("/api/vendor/transactions");
    assert.equal(unauthenticated.status, 401);
  });

  await t.test("returns null period dates for legacy payment records", async () => {
    const vendor = await createVendor("Vendor Legacy Payment");
    await transactions.insertOne({
      vendorId: vendor.user._id,
      plan: "premium",
      subscriptionPlan: "premium",
      amount: 49,
      currency: "usd",
      status: "paid",
      stripeSessionId: "cs_legacy_without_periods",
      createdAt: new Date(),
    });

    const history = await getJson("/api/vendor/transactions", vendor.token);
    assert.equal(history.status, 200);
    assert.equal(history.body.data.length, 1);
    assert.equal(history.body.data[0].amount, 49);
    assert.equal(history.body.data[0].periodStart, null);
    assert.equal(history.body.data[0].periodEnd, null);
  });

  await t.test("customer.subscription.updated saves renewed period dates", async () => {
    const vendor = await createVendor("Vendor Renewal");
    const subscriptionId = "sub_test_renewal";
    const renewedStartSec = futureSec;
    const renewedEndSec = futureSec + 30 * 24 * 60 * 60;
    subscriptions.set(subscriptionId, subscriptionFor(vendor.user._id, subscriptionId, "cus_renewal"));

    await processStripeEvent(
      checkoutEvent(vendor.user._id, {
        sessionId: "cs_test_renewal",
        subscriptionId,
        invoiceId: "in_test_renewal",
        customer: "cus_renewal",
      }),
      { db, stripe: fakeStripe },
    );

    let user = await users.findOne({ _id: vendor.user._id });
    assert.equal(user.currentPeriodStart.getTime(), periodStartSec * 1000);
    assert.equal(user.currentPeriodEnd.getTime(), futureSec * 1000);

    await processStripeEvent({
      id: "evt_sub_test_renewal",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...subscriptionFor(vendor.user._id, subscriptionId, "cus_renewal", renewedEndSec),
          current_period_start: renewedStartSec,
          items: { data: [{
            current_period_start: renewedStartSec,
            current_period_end: renewedEndSec,
            price: { id: "price_test_49" },
          }] },
        },
      },
    }, { db, stripe: fakeStripe });

    user = await users.findOne({ _id: vendor.user._id });
    assert.equal(user.currentPeriodStart.getTime(), renewedStartSec * 1000);
    assert.equal(user.currentPeriodEnd.getTime(), renewedEndSec * 1000);

    const subscription = await getJson("/api/vendor/subscription", vendor.token);
    assert.equal(subscription.body.data.currentPeriodStart, new Date(renewedStartSec * 1000).toISOString());
    assert.equal(subscription.body.data.currentPeriodEnd, new Date(renewedEndSec * 1000).toISOString());
  });

  await t.test("counts legacy services without isActive as active across subscription and overview", async () => {
    const vendor = await createVendor("Vendor Active Count");
    const now = Date.now();
    await db.collection("services").insertMany([
      { vendorId: vendor.user._id, serviceName: "Legacy one", status: "Approved", createdAt: new Date(now - 3000) },
      { vendorId: String(vendor.user._id), serviceName: "String id", status: "Pending", createdAt: new Date(now - 2000) },
      { vendorId: vendor.user._id, serviceName: "Disabled", status: "Approved", isActive: false, createdAt: new Date(now - 1000) },
      { vendorId: vendor.user._id, serviceName: "Rejected", status: "Rejected", createdAt: new Date(now) },
    ]);

    assert.equal(await countActiveServices(db, vendor.user._id), 2);
    assert.equal(await countActiveServices(db, String(vendor.user._id)), 2);

    const subscription = await getJson("/api/vendor/subscription", vendor.token);
    assert.equal(subscription.status, 200);
    assert.equal(subscription.body.data.activeServicesCount, 2);
    assert.equal(typeof subscription.body.data.activeServicesCount, "number");

    const overview = await getJson("/api/vendor/overview", vendor.token);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.data.activeServices, 2);
    assert.equal(overview.body.data.activeServicesCount, 2);

    const services = await getJson("/api/vendor/services", vendor.token);
    assert.equal(services.status, 200);
    const legacy = services.body.data.find((service) => service.serviceName === "Legacy one");
    assert.equal(legacy.isActive, true);
  });

  await t.test("downgrade keeps the three oldest active services and disables only the extras", async () => {
    const vendor = await createVendor("Vendor Downgrade Services");
    const subscriptionId = "sub_test_downgrade_services";
    const now = Date.now();
    await db.collection("services").insertMany(
      [0, 1, 2, 3, 4].map((index) => ({
        vendorId: vendor.user._id,
        serviceName: `Downgrade service ${index}`,
        status: "Approved",
        // Mix legacy missing fields with explicit true to prove one definition.
        ...(index % 2 === 0 ? {} : { isActive: true }),
        createdAt: new Date(now - (5 - index) * 60_000),
      })),
    );

    await processStripeEvent({
      id: "evt_sub_downgrade_services",
      type: "customer.subscription.deleted",
      data: {
        object: {
          ...subscriptionFor(vendor.user._id, subscriptionId, "cus_downgrade_services", Math.floor(Date.now() / 1000)),
          status: "canceled",
        },
      },
    }, { db, stripe: fakeStripe });

    const services = await db.collection("services")
      .find({ vendorId: vendor.user._id })
      .sort({ createdAt: 1 })
      .toArray();
    assert.equal(services.length, 5, "downgrade must not delete services");
    assert.equal(services.filter((service) => service.isActive === false).length, 2);
    assert.deepEqual(
      services.map((service) => service.isActive === false),
      [false, false, false, true, true],
    );
    assert.equal(await countActiveServices(db, String(vendor.user._id)), 3);
  });

  await t.test("downgrade leaves vendors at or below the active service limit untouched", async () => {
    const vendor = await createVendor("Vendor Downgrade At Limit");
    const subscriptionId = "sub_test_downgrade_at_limit";
    await db.collection("services").insertMany(
      [0, 1, 2].map((index) => ({
        vendorId: vendor.user._id,
        serviceName: `At limit service ${index}`,
        status: "Approved",
        createdAt: new Date(Date.now() - (3 - index) * 60_000),
      })),
    );

    await processStripeEvent({
      id: "evt_sub_downgrade_at_limit",
      type: "customer.subscription.deleted",
      data: {
        object: {
          ...subscriptionFor(vendor.user._id, subscriptionId, "cus_downgrade_at_limit", Math.floor(Date.now() / 1000)),
          status: "canceled",
        },
      },
    }, { db, stripe: fakeStripe });

    const services = await db.collection("services").find({ vendorId: vendor.user._id }).toArray();
    assert.equal(services.length, 3);
    assert.equal(services.filter((service) => service.isActive === false).length, 0);
    assert.equal(await countActiveServices(db, vendor.user._id), 3);
  });
});
