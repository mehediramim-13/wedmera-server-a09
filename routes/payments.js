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

router.post("/create-checkout-session", async (req, res, next) => {
  try {
    if (getEffectivePlan(req.user) === "premium") return sendResponse(res, 409, false, "Already subscribed to Premium.");
    const stripe = getStripe();
    const clientUrl = process.env.CLIENT_URL.split(",")[0].trim().replace(/\/+$/, "");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: String(req.user._id),
      metadata: { vendorId: String(req.user._id), plan: "premium" },
      subscription_data: { metadata: { vendorId: String(req.user._id) } },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment/cancel`,
    });
    sendResponse(res, 200, true, "Checkout session created.", { url: session.url });
  } catch (error) { next(error); }
});

router.get("/session/:sessionId", async (req, res, next) => {
  try {
    const transaction = await getDb().collection("transactions").findOne({
      stripeSessionId: req.params.sessionId,
      vendorId: req.user._id,
    });
    if (!transaction) return sendResponse(res, 200, true, "Payment is processing.", { status: "processing" });
    sendResponse(res, 200, true, "Payment status fetched.", {
      status: transaction.status,
      plan: transaction.plan,
      amount: transaction.amount,
      currency: transaction.currency,
      createdAt: transaction.createdAt,
    });
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
