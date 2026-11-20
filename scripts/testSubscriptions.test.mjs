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

await connectDB();
await initDatabase();
const db = getDb();
const users = db.collection(process.env.USERS_COLLECTION || "user");
const transactions = db.collection("transactions");

const apiServer = app.listen(0, "127.0.0.1");
await once(apiServer, "listening");
const base = `http://127.0.0.1:${apiServer.address().port}`;

const futureSec = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
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
  return {
    id,
    customer,
    status: "active",
    current_period_end: periodEnd,
    items: { data: [{ current_period_end: periodEnd, price: { id: "price_test_49" } }] },
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

  await t.test("uses a 31-day fallback expiry when Stripe period end is unavailable", async () => {
    const before = Date.now();
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
    assert.equal(userE.subscriptionPlan, "premium");
    assert.ok(userE.subscriptionExpiresAt instanceof Date);
    assert.ok(userE.subscriptionExpiresAt.getTime() > before + 30 * 24 * 60 * 60 * 1000);
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

  await t.test("keeps paid access until the period ends when a subscription is canceled", async () => {
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
      id: "evt_sub_c_canceled",
      type: "customer.subscription.updated",
      data: {
        object: {
          ...subscriptionFor(vendorC.user._id, "sub_test_c", "cus_c"),
          status: "canceled",
        },
      },
    }, { db, stripe: fakeStripe });

    let userC = await users.findOne({ _id: vendorC.user._id });
    assert.equal(userC.subscriptionPlan, "premium");
    assert.ok(userC.subscriptionExpiresAt.getTime() > Date.now());

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

    userC = await users.findOne({ _id: vendorC.user._id });
    assert.equal(userC.subscriptionPlan, "free");
  });

  await t.test("returns the persisted plan from subscription and profile endpoints", async () => {
    const subscription = await getJson("/api/vendor/subscription", vendorA.token);
    assert.equal(subscription.status, 200);
    assert.equal(subscription.body.data.plan, "premium");
    assert.equal(subscription.body.data.subscriptionPlan, "premium");
    assert.equal(subscription.body.data.currentPlan, "premium");
    assert.equal(subscription.body.data.effectivePlan, "premium");
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
    assert.ok(recordA.createdAt || recordA.date);

    const historyB = await getJson("/api/vendor/transactions", vendorB.token);
    assert.equal(historyB.status, 200);
    assert.equal(historyB.body.data.length, 1);
    assert.equal(historyB.body.data[0].status, "failed");
    assert.notEqual(String(historyB.body.data[0]._id), String(recordA._id));

    const unauthenticated = await getJson("/api/vendor/transactions");
    assert.equal(unauthenticated.status, 401);
  });
});
