import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { billingAccounts, payments, subscriptions, users, workspaces } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import type { CheckoutRequest, PaymentProvider, PaymentResult, ProviderEvent, SubscriptionState } from "./provider";
import { PAYMONGO_SCHEMA_STATEMENTS } from "./schemaSql";
import { createTestDb } from "./testDb";

vi.mock("../_core/rateLimit", async importOriginal => ({
  ...(await importOriginal<typeof import("../_core/rateLimit")>()),
  rateLimit: vi.fn(async () => ({ allowed: true, count: 1, resetMs: 0 })),
}));
vi.mock("../_core/mail", async importOriginal => ({ ...(await importOriginal<typeof import("../_core/mail")>()), sendMail: vi.fn(async () => true) }));
vi.mock("../uploadSweep", () => ({ tidyOwnerUploads: vi.fn() }));

const { appRouter } = await import("../routers");
const { setTestDb } = await import("../db");
const { enabledChannels, getPaymentProvider, setPaymentProvider } = await import("./checkout");
const { createApp } = await import("../_core/app");
const { getUserEntitlements } = await import("./service");

/**
 * A PayMongo-shaped gateway. It records what billing asked it to open, and answers read backs from tables the
 * test controls: checkout sessions by id, subscriptions by id. A webhook body is `{ event }`, signed when the
 * header is "good".
 */
class FakePayMongo implements PaymentProvider {
  readonly name = "paymongo";
  checkouts: CheckoutRequest[] = [];
  recurring: CheckoutRequest[] = [];
  canceled: string[] = [];
  cancelFails = false;
  sessions = new Map<string, Omit<PaymentResult, "invoiceNo">>();
  subs = new Map<string, SubscriptionState>();
  private seq = 0;
  async createCheckout(request: CheckoutRequest) {
    this.checkouts.push(request);
    return { redirectUrl: `https://checkout.paymongo.test/${request.invoiceNo}`, providerToken: `cs_${++this.seq}` };
  }
  createOneTimePayment(request: CheckoutRequest) {
    return this.createCheckout(request);
  }
  async createRecurringSubscription(request: CheckoutRequest) {
    this.recurring.push(request);
    return { redirectUrl: `https://maya.test/authorize/${request.invoiceNo}`, providerToken: `subs_${++this.seq}`, providerCustomerRef: request.customer?.providerCustomerRef ?? "cus_new" };
  }
  async cancelSubscription(ref: string) {
    if (this.cancelFails) throw new Error("PayMongo is down");
    this.canceled.push(ref);
  }
  async getSubscription(ref: string) {
    return this.subs.get(ref) ?? { status: "unknown" as const, latestInvoice: null };
  }
  async verifyCallback() {
    return null;
  }
  rawBodies: string[] = [];
  parseWebhook(rawBody: string, header: string | undefined): ProviderEvent | null {
    this.rawBodies.push(rawBody);
    if (header !== "good") return null;
    return (JSON.parse(rawBody) as { event: ProviderEvent }).event;
  }
  async getPaymentStatus(invoiceNo: string, ref?: string | null): Promise<PaymentResult> {
    const session = ref ? this.sessions.get(ref) : undefined;
    return { invoiceNo, ...(session ?? { status: "pending", amountMinor: 0, currency: "PHP", providerRef: null, channelCode: null, code: "open" }) };
  }
  async refundPayment() {}
}

const saved = { ...ENV };
let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let closeDb: () => Promise<void>;
let gateway: FakePayMongo;

const req = { protocol: "https", headers: {}, ip: "203.0.113.9", get: () => "heyitsme.test", query: {} } as unknown as TrpcContext["req"];
const callerFor = (user: typeof users.$inferSelect) => appRouter.createCaller({ user, req, res: {} as TrpcContext["res"] });

let seq = 0;
async function makeUser() {
  const [row] = await db.insert(users).values({ openId: `pm-${++seq}`, email: `buyer${seq}@example.com`, name: `Ada Buyer${seq}` }).returning();
  return row;
}
const paymentRow = async (invoiceNo: string) => (await db.select().from(payments).where(eq(payments.providerTransactionId, invoiceNo)))[0];

const PAYMONGO_ENV = {
  paymentsEnabled: true,
  paymentProvider: "paymongo",
  gcashEnabled: true,
  cardEnabled: true,
  mayaEnabled: true,
  qrphEnabled: true,
  googlePayEnabled: false,
  paymongoSubscriptionsEnabled: true,
  planLimitsEnabled: true,
  foundingOfferEnabled: false,
  complimentaryEmails: [],
};

beforeEach(async () => {
  const test = await createTestDb();
  db = test.db;
  closeDb = () => test.client.close();
  setTestDb(db);
  gateway = new FakePayMongo();
  setPaymentProvider(gateway);
  Object.assign(ENV, PAYMONGO_ENV);
});

afterEach(async () => {
  Object.assign(ENV, saved);
  setPaymentProvider(null);
  setTestDb(null);
  await closeDb();
});

afterAll(() => vi.restoreAllMocks());

describe("provider and channels", () => {
  it("picks the gateway named by PAYMENT_PROVIDER, and keeps 2C2P selectable", () => {
    setPaymentProvider(null);
    Object.assign(ENV, { paymentProvider: "paymongo", paymongoSecretKey: "sk_test_x", paymongoWebhookSecret: "whsk_x" });
    expect(getPaymentProvider().name).toBe("paymongo");
    Object.assign(ENV, { paymentProvider: "2c2p", paymentGatewayMerchantId: "JT01", paymentGatewaySecret: "secret" });
    expect(getPaymentProvider().name).toBe("2c2p");
    Object.assign(ENV, { paymentProvider: "stripe" });
    expect(() => getPaymentProvider()).toThrow(expect.objectContaining({ code: "not_configured" }));
  });

  it("offers only the channels the chosen gateway takes", () => {
    Object.assign(ENV, { googlePayEnabled: true });
    expect(enabledChannels()).toEqual(["gcash", "qrph", "maya", "card"]);
    Object.assign(ENV, { paymentProvider: "2c2p" });
    expect(enabledChannels()).toEqual(["googlepay", "gcash"]);
    Object.assign(ENV, { paymentProvider: "paymongo", mayaEnabled: false, cardEnabled: false });
    expect(enabledChannels()).toEqual(["gcash", "qrph"]);
  });
});

describe("PayMongo checkout", () => {
  it("auto-renews Maya through a PayMongo subscription for the buyer, and saves the buyer's PayMongo customer", async () => {
    const user = await makeUser();
    const result = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    expect(result.redirectUrl).toBe(`https://maya.test/authorize/${result.invoiceNo}`);
    expect(gateway.checkouts).toHaveLength(0);
    expect(gateway.recurring[0]).toMatchObject({
      amountMinor: 29900,
      channel: "maya",
      customer: { email: user.email, name: user.name, providerCustomerRef: null },
      frontendReturnUrl: `https://heyitsme.test/api/payments/paymongo/return?invoice=${result.invoiceNo}`,
    });
    expect(await paymentRow(result.invoiceNo)).toMatchObject({ status: "pending", provider: "paymongo", channel: "maya", providerCheckoutRef: "subs_1" });
    const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.ownerUserId, user.id));
    expect(account.providerCustomerRef).toBe("cus_new");

    await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    expect(gateway.recurring[1].customer?.providerCustomerRef).toBe("cus_new");
  });

  it("sells GCash, QR Ph and card as one prepaid month on the hosted page", async () => {
    const user = await makeUser();
    for (const channel of ["gcash", "qrph", "card"] as const) {
      const result = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel });
      expect(await paymentRow(result.invoiceNo)).toMatchObject({ status: "pending", channel, providerCheckoutRef: expect.stringMatching(/^cs_/) });
    }
    expect(gateway.checkouts.map(request => request.channel)).toEqual(["gcash", "qrph", "card"]);
    expect(gateway.recurring).toHaveLength(0);
  });

  it("sells Maya as one prepaid month too while PayMongo Subscriptions is off", async () => {
    Object.assign(ENV, { paymongoSubscriptionsEnabled: false });
    const user = await makeUser();
    await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    expect(gateway.recurring).toHaveLength(0);
    expect(gateway.checkouts[0].channel).toBe("maya");
  });
});

/** Posts to the webhook through the whole Express app, the way PayMongo delivers it. */
async function deliver(body: string, signature = "good") {
  const server = createApp().listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/payments/paymongo/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Paymongo-Signature": signature },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe("PayMongo webhook route", () => {
  it("checks the signature over the exact bytes PayMongo sent", async () => {
    const body = '{ "event" : {"kind":"ignored","type":"payment.paid"},  "pad": "\u00e9" }';
    const res = await deliver(body);
    expect(res).toEqual({ status: 200, body: { received: true } });
    expect(gateway.rawBodies).toEqual([body]);
  });

  it("refuses an unsigned delivery", async () => {
    const res = await deliver(JSON.stringify({ event: { kind: "checkout", ref: "cs_1" } }), "forged");
    expect(res.status).toBe(400);
  });

  it("answers 200 to a signed event it does not act on, so PayMongo stops retrying", async () => {
    const res = await deliver(JSON.stringify({ event: { kind: "checkout", ref: "cs_unknown" } }));
    expect(res).toEqual({ status: 200, body: { received: true } });
  });
});

const sessionPaid = (amountMinor = 29900) => ({ status: "succeeded" as const, amountMinor, currency: "PHP", providerRef: "pay_1", channelCode: "gcash", code: "paid" });
const checkoutEvent = (ref: string) => JSON.stringify({ event: { kind: "checkout", ref } });

describe("PayMongo one-time settlement", () => {
  it("GCash: a paid session read back from PayMongo turns on Pro for one month, once", async () => {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;

    // The event alone grants nothing: PayMongo still says the session is open.
    expect((await deliver(checkoutEvent(ref))).status).toBe(200);
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("free");

    gateway.sessions.set(ref, sessionPaid());
    expect((await deliver(checkoutEvent(ref))).status).toBe(200);
    const me = await callerFor(user).billing.me();
    expect(me.entitlements.plan).toBe("pro");
    expect(await paymentRow(invoiceNo)).toMatchObject({ status: "succeeded", providerInvoiceRef: "pay_1" });

    const end = me.subscription?.currentPeriodEnd;
    await deliver(checkoutEvent(ref));
    expect((await callerFor(user).billing.me()).subscription?.currentPeriodEnd).toEqual(end);
  });

  it("refuses a paid amount that is not the server's quote", async () => {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "qrph" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.sessions.set(ref, sessionPaid(100));
    await deliver(checkoutEvent(ref));
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("free");
    expect(await paymentRow(invoiceNo)).toMatchObject({ status: "failed", failureCode: "amount_mismatch" });
  });
});

const subscriptionEvent = (ref: string) => JSON.stringify({ event: { kind: "subscription", ref } });
const paidInvoice = (ref: string, amountMinor = 29900) => ({ ref, paid: true, amountMinor, currency: "PHP" });
const DAY = 86_400_000;
const userPayments = async (userId: number) => db.select().from(payments).where(eq(payments.userId, userId)).orderBy(payments.id);
const proRow = async (userId: number) => {
  const [account] = await db.select().from(billingAccounts).where(eq(billingAccounts.ownerUserId, userId));
  return (await db.select().from(subscriptions).where(eq(subscriptions.billingAccountId, account.id)))[0];
};

describe("PayMongo auto-renewal", () => {
  async function mayaBuyer() {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    return { user, invoiceNo, ref };
  }

  it("settles the first Maya payment from the subscription PayMongo reports, and links the plan to it", async () => {
    const { user, invoiceNo, ref } = await mayaBuyer();
    gateway.subs.set(ref, { status: "incomplete", latestInvoice: { ...paidInvoice("inv_1"), paid: false } });
    await deliver(subscriptionEvent(ref));
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("free");

    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    expect((await deliver(subscriptionEvent(ref))).status).toBe(200);
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("pro");
    expect(await paymentRow(invoiceNo)).toMatchObject({ status: "succeeded", providerInvoiceRef: "inv_1" });
    expect(await proRow(user.id)).toMatchObject({ status: "active", providerSubscriptionRef: ref });
  });

  it("records each paid renewal invoice as one renewal payment and moves the plan end one month, once", async () => {
    const { user, ref } = await mayaBuyer();
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    const firstEnd = (await proRow(user.id)).currentPeriodEnd;

    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_2") });
    await deliver(subscriptionEvent(ref));
    await deliver(subscriptionEvent(ref));

    const rows = await userPayments(user.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ purpose: "renewal", provider: "paymongo", channel: "maya", status: "succeeded", amountMinor: 29900, providerInvoiceRef: "inv_2", providerCheckoutRef: ref });
    const days = ((await proRow(user.id)).currentPeriodEnd.getTime() - firstEnd.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
  });

  it("refuses a renewal invoice for another amount", async () => {
    const { user, ref } = await mayaBuyer();
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    const firstEnd = (await proRow(user.id)).currentPeriodEnd;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_2", 100) });
    await deliver(subscriptionEvent(ref));
    expect((await userPayments(user.id))[1]).toMatchObject({ status: "failed", failureCode: "amount_mismatch" });
    expect((await proRow(user.id)).currentPeriodEnd).toEqual(firstEnd);
  });

  it("renews a team paid by Maya, and moves its plan date one month each time", async () => {
    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const owner = await makeUser();
    const team = await callerFor(owner).teams.create({ name: "Acme" });
    const { invoiceNo } = await callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    expect(gateway.recurring[0]).toMatchObject({ amountMinor: 149900, customer: { email: owner.email } });

    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1", 149900) });
    await deliver(subscriptionEvent(ref));
    const [paidTeam] = await db.select().from(workspaces).where(eq(workspaces.id, team.id));
    expect(paidTeam.providerSubscriptionRef).toBe(ref);

    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_2", 149900) });
    await deliver(subscriptionEvent(ref));
    const [renewed] = await db.select().from(workspaces).where(eq(workspaces.id, team.id));
    const days = (renewed.accessUntil!.getTime() - paidTeam.accessUntil!.getTime()) / DAY;
    expect(days).toBeGreaterThanOrEqual(28);
    expect(days).toBeLessThanOrEqual(31);
    expect((await userPayments(owner.id))[1]).toMatchObject({ purpose: "teams", status: "succeeded", providerInvoiceRef: "inv_2" });
  });

  it("ignores a subscription heyitsme never opened", async () => {
    gateway.subs.set("subs_stranger", { status: "active", latestInvoice: paidInvoice("inv_9") });
    expect((await deliver(subscriptionEvent("subs_stranger"))).status).toBe(200);
    expect(await db.select().from(payments)).toHaveLength(0);
  });
});

describe("PayMongo subscription status", () => {
  async function activeMaya() {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    return { user, ref, end: (await proRow(user.id)).currentPeriodEnd };
  }
  const planAt = async (user: typeof users.$inferSelect, at: Date) => (await getUserEntitlements(db, user, at)).plan;
  const failedRenewal = { ...paidInvoice("inv_2"), paid: false };

  it("past due: Pro stays for the 3 days of grace after the plan end, then ends", async () => {
    const { user, ref, end } = await activeMaya();
    gateway.subs.set(ref, { status: "past_due", latestInvoice: failedRenewal });
    await deliver(subscriptionEvent(ref));
    expect((await proRow(user.id)).status).toBe("past_due");
    expect(await planAt(user, new Date(end.getTime() + 2 * DAY))).toBe("pro");
    expect(await planAt(user, new Date(end.getTime() + 4 * DAY))).toBe("free");
  });

  it("a renewal paid after past due makes the plan active again and moves its end", async () => {
    const { user, ref, end } = await activeMaya();
    gateway.subs.set(ref, { status: "past_due", latestInvoice: failedRenewal });
    await deliver(subscriptionEvent(ref));
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_2") });
    await deliver(subscriptionEvent(ref));
    const row = await proRow(user.id);
    expect(row.status).toBe("active");
    expect(row.currentPeriodEnd.getTime()).toBeGreaterThan(end.getTime() + 27 * DAY);
  });

  it("unpaid after PayMongo's retries: Pro ends now", async () => {
    const { user, ref } = await activeMaya();
    gateway.subs.set(ref, { status: "unpaid", latestInvoice: failedRenewal });
    await deliver(subscriptionEvent(ref));
    expect((await proRow(user.id)).status).toBe("expired");
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("free");
  });

  it("cancelled at PayMongo: Pro runs to the end of the paid month, then stops", async () => {
    const { user, ref, end } = await activeMaya();
    gateway.subs.set(ref, { status: "canceled", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    expect(await proRow(user.id)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
    expect(await planAt(user, new Date(end.getTime() - DAY))).toBe("pro");
    expect(await planAt(user, new Date(end.getTime() + DAY))).toBe("free");
  });
});

describe("cancel and resume", () => {
  async function activeMaya() {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    return { user, ref };
  }

  it("stops the PayMongo subscription, and keeps Pro to the end of the paid month", async () => {
    const { user, ref } = await activeMaya();
    await callerFor(user).billing.cancelSubscription();
    expect(gateway.canceled).toEqual([ref]);
    expect(await proRow(user.id)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
    expect((await callerFor(user).billing.me()).entitlements.plan).toBe("pro");
  });

  it("changes nothing when PayMongo cannot stop it, so the buyer is not charged after a cancel", async () => {
    const { user } = await activeMaya();
    gateway.cancelFails = true;
    await expect(callerFor(user).billing.cancelSubscription()).rejects.toThrow(/could not be stopped/);
    expect(await proRow(user.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
  });

  it("cancels a prepaid month in heyitsme only", async () => {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.sessions.set(ref, sessionPaid());
    await deliver(checkoutEvent(ref));
    await callerFor(user).billing.cancelSubscription();
    expect(gateway.canceled).toEqual([]);
    expect(await proRow(user.id)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
  });

  it("resume after a cancel keeps Pro, renewed by hand: PayMongo cannot restart a cancelled subscription", async () => {
    const { user } = await activeMaya();
    await callerFor(user).billing.cancelSubscription();
    await callerFor(user).billing.resumeSubscription();
    expect(await proRow(user.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false, providerSubscriptionRef: null });
  });
});

describe("schema", () => {
  it("ensureSchema runs exactly the statements of drizzle/0023_paymongo.sql", () => {
    const file = readFileSync(path.resolve(import.meta.dirname, "../../drizzle/0023_paymongo.sql"), "utf8");
    const statements = file
      .split("\n")
      .filter(line => !line.startsWith("--"))
      .join("\n")
      .split(";")
      .map(statement => statement.trim())
      .filter(Boolean);
    expect([...PAYMONGO_SCHEMA_STATEMENTS]).toEqual(statements);
  });
});
