import express, { type Express, type Request, type Response } from "express";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { payments, subscriptions, workspaces } from "../../drizzle/schema";
import { clientIp, hashIdentifier, rateLimit } from "../_core/rateLimit";
import { logJson, siteOrigin } from "../_core/seo";
import { getDb } from "../db";
import { getPaymentProvider, newInvoiceNo, reconcileInvoice } from "./checkout";
import { notifyActivation } from "./paymentRoutes";
import type { PaymentProvider, PaymentResult, SubscriptionState } from "./provider";
import { settlePayment, type Db, type SettleOutcome } from "./service";

// PayMongo webhooks. The signature covers the raw bytes, so this route reads the body itself and must be
// registered before the app's JSON parser. A verified event is only a hint: the handler reads the object back
// from PayMongo and settles from that answer, once, under the same row lock as every other payment.

/** A paid Checkout Session settles the payment row that opened it. */
async function settleCheckout(db: Db, checkoutRef: string, origin: string) {
  const [row] = await db
    .select({ invoiceNo: payments.providerTransactionId })
    .from(payments)
    .where(eq(payments.providerCheckoutRef, checkoutRef))
    .limit(1);
  if (!row) {
    logJson("warn", "paymongo webhook for an unknown checkout", { checkoutRef });
    return;
  }
  const outcome = await reconcileInvoice(db, row.invoiceNo);
  await notifyActivation(outcome, origin);
}

/**
 * The plan follows what PayMongo reports (D3). Past due keeps Pro for PAST_DUE_GRACE_DAYS after the plan end.
 * Unpaid, after PayMongo's last retry, ends it now. A cancel made at PayMongo keeps the paid month. Only a paid
 * invoice makes a lapsed plan active again (settlePayment), so an "active" report only clears past due.
 */
async function applySubscriptionStatus(db: Db, providerSubscriptionRef: string, status: SubscriptionState["status"]) {
  const now = new Date();
  const mine = eq(subscriptions.providerSubscriptionRef, providerSubscriptionRef);
  if (status === "past_due") {
    await db.update(subscriptions).set({ status: "past_due", updatedAt: now }).where(and(mine, eq(subscriptions.status, "active")));
  } else if (status === "unpaid") {
    await db.update(subscriptions).set({ status: "expired", updatedAt: now }).where(and(mine, inArray(subscriptions.status, ["active", "past_due"])));
  } else if (status === "canceled") {
    await db
      .update(subscriptions)
      .set({ status: "canceled", cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now })
      .where(and(mine, inArray(subscriptions.status, ["active", "past_due"])));
  } else if (status === "active") {
    await db.update(subscriptions).set({ status: "active", updatedAt: now }).where(and(mine, eq(subscriptions.status, "past_due")));
  }
  // A team whose subscription PayMongo has ended renews by hand again, so its owner can pay another way.
  if (status === "unpaid" || status === "canceled") {
    await db.update(workspaces).set({ providerSubscriptionRef: null, updatedAt: now }).where(eq(workspaces.providerSubscriptionRef, providerSubscriptionRef));
  }
}

/**
 * Reads one subscription back from the gateway, settles its latest paid invoice, then applies its status.
 * The first invoice settles the payment row checkout opened. A later one becomes a new `payments` row (purpose `renewal`, or `teams` for
 * a team) copied from that first row, so the price and the plan are the ones the buyer agreed to. The invoice id
 * is unique on `payments.providerInvoiceRef`, so a repeated delivery finds its row and changes nothing.
 */
export async function reconcileSubscription(db: Db, provider: PaymentProvider, providerSubscriptionRef: string): Promise<SettleOutcome | null> {
  const opened = await db
    .select()
    .from(payments)
    .where(eq(payments.providerCheckoutRef, providerSubscriptionRef))
    .orderBy(asc(payments.id))
    .limit(1);
  const first = opened[0];
  if (!first) {
    logJson("warn", "paymongo webhook for an unknown subscription", { providerSubscriptionRef });
    return null;
  }
  const state = await provider.getSubscription(providerSubscriptionRef);
  const outcome = state.latestInvoice?.paid ? await settleLatestInvoice(db, first, providerSubscriptionRef, state.latestInvoice) : null;
  await applySubscriptionStatus(db, providerSubscriptionRef, state.status);
  return outcome;
}

async function settleLatestInvoice(
  db: Db,
  first: typeof payments.$inferSelect,
  providerSubscriptionRef: string,
  invoice: NonNullable<SubscriptionState["latestInvoice"]>
): Promise<SettleOutcome | null> {
  const result = (invoiceNo: string): PaymentResult => ({
    invoiceNo,
    status: "succeeded",
    amountMinor: invoice.amountMinor,
    currency: invoice.currency,
    providerRef: invoice.ref,
    channelCode: first.channel,
    code: "paid",
    providerSubscriptionRef,
  });

  const [known] = await db.select({ invoiceNo: payments.providerTransactionId }).from(payments).where(eq(payments.providerInvoiceRef, invoice.ref)).limit(1);
  let invoiceNo = known?.invoiceNo;
  if (!invoiceNo) {
    const [unpaidFirst] = await db
      .select({ invoiceNo: payments.providerTransactionId })
      .from(payments)
      .where(and(eq(payments.id, first.id), isNull(payments.providerInvoiceRef), ne(payments.status, "succeeded")))
      .limit(1);
    invoiceNo = unpaidFirst?.invoiceNo;
  }
  if (!invoiceNo) {
    const [renewal] = await db
      .insert(payments)
      .values({
        billingAccountId: first.billingAccountId,
        userId: first.userId,
        provider: first.provider,
        providerTransactionId: newInvoiceNo(),
        providerInvoiceRef: invoice.ref,
        providerCheckoutRef: providerSubscriptionRef,
        purpose: first.purpose === "teams" ? "teams" : "renewal",
        planCode: first.planCode,
        billingCycle: first.billingCycle,
        channel: first.channel,
        amountMinor: first.amountMinor,
        currency: first.currency,
        status: "pending",
        metadataJson: first.metadataJson,
      })
      .onConflictDoNothing()
      .returning({ invoiceNo: payments.providerTransactionId });
    // Another delivery inserted it a moment ago and settles it.
    if (!renewal) return null;
    invoiceNo = renewal.invoiceNo;
  }
  const outcome = await settlePayment(db, result(invoiceNo));
  logJson("info", "paymongo subscription settled", { providerSubscriptionRef, invoiceRef: invoice.ref, outcome: outcome.outcome });
  return outcome;
}

async function handleWebhook(req: Request, res: Response) {
  const limit = await rateLimit(`payment-webhook:${hashIdentifier(clientIp(req))}`, 120, 60_000);
  if (!limit.allowed) {
    res.status(429).json({ error: "Too many requests." });
    return;
  }
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Unavailable." });
    return;
  }
  const provider = getPaymentProvider();
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const signature = typeof req.headers["paymongo-signature"] === "string" ? req.headers["paymongo-signature"] : undefined;
  const event = provider.parseWebhook?.(rawBody, signature) ?? null;
  if (!event) {
    logJson("warn", "paymongo webhook rejected", { reason: "unverified" });
    res.status(400).json({ error: "Bad request." });
    return;
  }
  try {
    if (event.kind === "checkout") await settleCheckout(db, event.ref, siteOrigin(req));
    if (event.kind === "subscription") {
      const outcome = await reconcileSubscription(db, provider, event.ref);
      if (outcome) await notifyActivation(outcome, siteOrigin(req));
    }
    res.status(200).json({ received: true });
  } catch (error) {
    // 5xx makes PayMongo retry; settlement is idempotent, so a retry is safe.
    logJson("error", "paymongo webhook settle failed", { kind: event.kind, error: String(error) });
    res.status(500).json({ error: "Something went wrong on our side." });
  }
}

/** Registered before express.json, so the signature is checked over the bytes PayMongo signed. */
export function registerPaymentWebhooks(app: Express) {
  app.post("/api/payments/paymongo/webhook", express.raw({ type: () => true, limit: "100kb" }), handleWebhook);
}

export const _test = { handleWebhook };
