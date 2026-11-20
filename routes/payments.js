import { Router } from "express";
import Stripe from "stripe";
import { getDb } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/roles.js";
import { getEffectivePlan, sendResponse } from "../helpers.js";

const router = Router();
router.use(requireAuth, requireRole("vendor"));

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("Missing required environment variable: STRIPE_SECRET_KEY");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const validatedPriceIds = new Set();

function checkoutConfigError(message) {
  const error = new Error(message);
  error.status = 500;
  error.expose = true;
  return error;
}

// Stripe Checkout expects a Price ID (price_...), never a Product ID (prod_...).
// Validate the configured value once per Price ID so a bad config yields a clear
// server error instead of an opaque Stripe failure on every checkout attempt.
async function resolvePremiumPriceId(stripe) {
  const priceId = (process.env.STRIPE_PRICE_ID || "").trim();
  if (!priceId) {
    throw checkoutConfigError(
      "Stripe is not configured: STRIPE_PRICE_ID is missing. Set it to the recurring USD $49/month Price ID (price_...).",
    );
  }
  if (priceId.startsWith("prod_")) {
    throw checkoutConfigError(
      "Stripe is misconfigured: STRIPE_PRICE_ID contains a Product ID (prod_...). Set it to that product's recurring USD $49/month Price ID (price_...).",
    );
  }
  if (!priceId.startsWith("price_")) {
    throw checkoutConfigError(
      'Stripe is misconfigured: STRIPE_PRICE_ID must be a Price ID starting with "price_".',
    );
  }
  if (validatedPriceIds.has(priceId)) return priceId;

  let price;
  try {
    price = await stripe.prices.retrieve(priceId);
  } catch (error) {
    if (error?.code === "resource_missing") {
      throw checkoutConfigError(
        "Stripe is misconfigured: STRIPE_PRICE_ID does not match a Price in the Stripe account. Set it to a valid recurring Price ID (price_...).",
      );
    }
    throw error;
  }
  if (!price.active) {
    throw checkoutConfigError("Stripe is misconfigured: the Price referenced by STRIPE_PRICE_ID is inactive.");
  }
  if (!price.recurring) {
    throw checkoutConfigError(
      "Stripe is misconfigured: the Price referenced by STRIPE_PRICE_ID is not a recurring price, but checkout uses subscription mode.",
    );
  }

  validatedPriceIds.add(priceId);
  return priceId;
}

router.post("/create-checkout-session", async (req, res, next) => {
  try {
    if (getEffectivePlan(req.user) === "premium") return sendResponse(res, 409, false, "Already subscribed to Premium.");
    const stripe = getStripe();
    const priceId = await resolvePremiumPriceId(stripe);
    const clientUrl = process.env.CLIENT_URL.split(",")[0].trim().replace(/\/+$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: String(req.user._id),
      metadata: { vendorId: String(req.user._id), plan: "premium" },
      subscription_data: { metadata: { vendorId: String(req.user._id) } },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    });
    sendResponse(res, 200, true, "Checkout session created.", { url: session.url });
  } catch (error) {
    if (error?.expose) {
      console.error(`Stripe checkout configuration error: ${error.message}`);
      return sendResponse(res, error.status || 500, false, error.message);
    }
    // A Price can disappear between validation and session creation. Surface it
    // as a configuration problem instead of an opaque server error.
    if (error?.code === "resource_missing" && /price/i.test(error?.message || "")) {
      return sendResponse(res, 500, false, "Stripe is misconfigured: STRIPE_PRICE_ID does not reference an existing Price.");
    }
    next(error);
  }
});

router.get("/session/:sessionId", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const sessionId = req.params.sessionId;
  const vendorId = req.user._id;

  try {
    const transaction = await getDb().collection("transactions").findOne({
      stripeSessionId: sessionId,
    });
    if (transaction && String(transaction.vendorId) === String(vendorId)) {
      return sendResponse(res, 200, true, "Payment status fetched.", {
        status: "paid",
        transaction,
      });
    }

    // The webhook may not have saved the transaction yet. Retrieve the Checkout
    // Session read-only so the success page can show a safe processing state.
    // This endpoint never writes subscription or payment state.
    let session = null;
    try {
      session = await getStripe().checkout.sessions.retrieve(sessionId);
    } catch (error) {
      console.error(`[payments-session] Stripe retrieval failed for ${sessionId}: ${error?.message || error}`);
    }

    if (session) {
      const ownerId = session.metadata?.vendorId || session.client_reference_id;
      if (!ownerId || String(ownerId) !== String(vendorId)) {
        return sendResponse(res, 403, false, "Forbidden.");
      }
      return sendResponse(res, 200, true, "Payment is processing.", {
        status: "processing",
        paymentStatus: session.payment_status,
      });
    }

    return sendResponse(res, 200, true, "Payment is processing.", { status: "processing" });
  } catch (error) { next(error); }
});

router.post("/cancel-subscription", async (req, res, next) => {
  try {
    if (!req.user.stripeSubscriptionId) return sendResponse(res, 404, false, "No active subscription found.");
    const stripe = getStripe();
    await stripe.subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end: true });
    sendResponse(res, 200, true, "Subscription will cancel at the end of the billing period.");
  } catch (error) { next(error); }
});

export default router;
