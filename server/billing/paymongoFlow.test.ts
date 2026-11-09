import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { billingAccounts, payments, subscriptions, users, workspaceMembers, workspaces } from "../../drizzle/schema";
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
const { runPlanCron } = await import("./planCron");
const { sendMail } = await import("../_core/mail");

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
    if (ref?.startsWith("subs_")) {
      const invoice = this.subs.get(ref)?.latestInvoice;
      return invoice?.paid
        ? { invoiceNo, status: "succeeded", amountMinor: invoice.amountMinor, currency: invoice.currency, providerRef: invoice.ref, channelCode: "paymaya", code: "paid", providerSubscriptionRef: ref }
        : { invoiceNo, status: "pending", amountMinor: 0, currency: "PHP", providerRef: null, channelCode: null, code: "open" };
    }
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

  it("answers 503 while the active gateway has no credentials, and keeps serving", async () => {
    setPaymentProvider(null);
    Object.assign(ENV, { paymentProvider: "2c2p", paymentGatewayMerchantId: "", paymentGatewaySecret: "" });
    expect((await deliver(checkoutEvent("cs_1"))).status).toBe(503);
    Object.assign(ENV, { paymentProvider: "paymongo", paymongoSecretKey: "" });
    expect((await deliver(checkoutEvent("cs_1"))).status).toBe(503);
  });

  it("answers 400 when the active gateway takes no PayMongo webhooks", async () => {
    setPaymentProvider(null);
    Object.assign(ENV, { paymentProvider: "2c2p", paymentGatewayMerchantId: "JT01", paymentGatewaySecret: "secret" });
    expect((await deliver(checkoutEvent("cs_1"))).status).toBe(400);
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

  it("refuses a second checkout for a plan that already renews by itself, so nobody pays twice", async () => {
    const { user, ref } = await mayaBuyer();
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    for (const channel of ["maya", "gcash"] as const) {
      await expect(callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel })).rejects.toThrow(/renews by itself/);
    }
    expect(gateway.recurring).toHaveLength(1);

    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const team = await callerFor(user).teams.create({ name: "Acme" });
    const { invoiceNo } = await callerFor(user).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" });
    const teamRef = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(teamRef, { status: "active", latestInvoice: paidInvoice("inv_t1", 149900) });
    await deliver(subscriptionEvent(teamRef));
    await expect(callerFor(user).billing.createTeamCheckout({ workspaceId: team.id, channel: "gcash" })).rejects.toThrow(/renews by itself/);
  });

  it("links the plan when the Billing page settles the first Maya payment before the webhook arrives", async () => {
    const { user, invoiceNo, ref } = await mayaBuyer();
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    expect((await callerFor(user).billing.paymentStatus({ invoiceNo })).status).toBe("succeeded");
    expect(await proRow(user.id)).toMatchObject({ status: "active", providerSubscriptionRef: ref });

    await deliver(subscriptionEvent(ref));
    expect(await proRow(user.id)).toMatchObject({ status: "active", providerSubscriptionRef: ref });
    await expect(callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" })).rejects.toThrow(/renews by itself/);
    await callerFor(user).billing.cancelSubscription();
    expect(gateway.canceled).toEqual([ref]);

    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const team = await callerFor(user).teams.create({ name: "Acme" });
    const teamCheckout = await callerFor(user).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" });
    const teamRef = (await paymentRow(teamCheckout.invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(teamRef, { status: "active", latestInvoice: paidInvoice("inv_t1", 149900) });
    expect((await callerFor(user).billing.paymentStatus({ invoiceNo: teamCheckout.invoiceNo })).status).toBe("succeeded");
    const [paidTeam] = await db.select().from(workspaces).where(eq(workspaces.id, team.id));
    expect(paidTeam.providerSubscriptionRef).toBe(teamRef);
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

describe("a team's PayMongo subscription", () => {
  async function mayaTeam() {
    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const owner = await makeUser();
    const team = await callerFor(owner).teams.create({ name: "Acme" });
    const { invoiceNo } = await callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1", 149900) });
    await deliver(subscriptionEvent(ref));
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, team.id));
    return { owner, team, ref, row };
  }
  const teamRow = async (id: number) => (await db.select().from(workspaces).where(eq(workspaces.id, id)))[0];

  for (const status of ["unpaid", "canceled"] as const) {
    it(`${status} at PayMongo: the team renews by hand again, so its owner can pay another way`, async () => {
      const { owner, team, ref } = await mayaTeam();
      gateway.subs.set(ref, { status, latestInvoice: { ...paidInvoice("inv_2", 149900), paid: false } });
      await deliver(subscriptionEvent(ref));
      expect((await teamRow(team.id)).providerSubscriptionRef).toBeNull();
      expect((await callerFor(owner).teams.billing({ workspaceId: team.id })).renewsAutomatically).toBe(false);
      await expect(callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "gcash" })).resolves.toMatchObject({ redirectUrl: expect.any(String) });
    });
  }

  it("the owner stops it at PayMongo, keeps the paid month, and renews by hand from then on", async () => {
    const { owner, team, ref, row } = await mayaTeam();
    const result = await callerFor(owner).billing.cancelTeamSubscription({ workspaceId: team.id });
    expect(gateway.canceled).toEqual([ref]);
    expect(result.accessUntil).toEqual(row.accessUntil);
    expect(await teamRow(team.id)).toMatchObject({ providerSubscriptionRef: null, accessUntil: row.accessUntil });
    expect((await callerFor(owner).teams.billing({ workspaceId: team.id })).renewsAutomatically).toBe(false);
    await expect(callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "gcash" })).resolves.toMatchObject({ redirectUrl: expect.any(String) });
    await expect(callerFor(owner).billing.cancelTeamSubscription({ workspaceId: team.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("changes nothing when PayMongo cannot stop it", async () => {
    const { owner, team, ref } = await mayaTeam();
    gateway.cancelFails = true;
    await expect(callerFor(owner).billing.cancelTeamSubscription({ workspaceId: team.id })).rejects.toThrow(/could not be stopped/);
    expect((await teamRow(team.id)).providerSubscriptionRef).toBe(ref);
  });

  it("only the team owner can stop it", async () => {
    const { team, ref } = await mayaTeam();
    const member = await makeUser();
    await db.insert(workspaceMembers).values({ workspaceId: team.id, userId: member.id, email: member.email!, role: "admin", status: "active" });
    await expect(callerFor(member).billing.cancelTeamSubscription({ workspaceId: team.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(gateway.canceled).toEqual([]);
    expect((await teamRow(team.id)).providerSubscriptionRef).toBe(ref);
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

  it("stops a past due plan at PayMongo, so PayMongo stops retrying the charge", async () => {
    const { user, ref } = await activeMaya();
    gateway.subs.set(ref, { status: "past_due", latestInvoice: { ...paidInvoice("inv_2"), paid: false } });
    await deliver(subscriptionEvent(ref));
    expect((await proRow(user.id)).status).toBe("past_due");
    await callerFor(user).billing.cancelSubscription();
    expect(gateway.canceled).toEqual([ref]);
    expect(await proRow(user.id)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
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

describe("renew by hand after a cancel", () => {
  it("a Maya plan canceled and then paid with GCash renews by hand: a reminder, and the next checkout opens", async () => {
    const user = await makeUser();
    const maya = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    const ref = (await paymentRow(maya.invoiceNo)).providerCheckoutRef!;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice("inv_1") });
    await deliver(subscriptionEvent(ref));
    await callerFor(user).billing.cancelSubscription();

    const gcash = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" });
    const session = (await paymentRow(gcash.invoiceNo)).providerCheckoutRef!;
    gateway.sessions.set(session, { ...sessionPaid(), providerRef: "pay_renew" });
    await deliver(checkoutEvent(session));

    const me = await callerFor(user).billing.me();
    expect(me.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: false, renewsAutomatically: false });
    vi.mocked(sendMail).mockClear();
    const at = new Date(me.subscription!.currentPeriodEnd.getTime() - 2 * DAY);
    expect((await runPlanCron(db, "https://heyitsme.test", at)).renewalReminders).toBe(1);
    await expect(callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" })).resolves.toMatchObject({ redirectUrl: expect.any(String) });
  });
});

describe("renew early", () => {
  const RENEW_EARLY = /only once the paid time ends/;

  it("Pro with paid time left renews early by a one-time payment only; Maya auto-renewal opens once the plan ends", async () => {
    const user = await makeUser();
    const first = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "gcash" });
    const session = (await paymentRow(first.invoiceNo)).providerCheckoutRef!;
    gateway.sessions.set(session, sessionPaid());
    await deliver(checkoutEvent(session));

    await expect(callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" })).rejects.toThrow(RENEW_EARLY);
    expect(gateway.recurring).toHaveLength(0);
    await expect(callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "qrph" })).resolves.toMatchObject({ redirectUrl: expect.any(String) });

    const row = await proRow(user.id);
    await db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() - DAY) }).where(eq(subscriptions.id, row.id));
    await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel: "maya" });
    expect(gateway.recurring).toHaveLength(1);
  });

  it("a team with paid time left renews early by a one-time payment only; Maya auto-renewal opens once the plan ends", async () => {
    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const owner = await makeUser();
    const team = await callerFor(owner).teams.create({ name: "Acme" });
    const first = await callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "gcash" });
    const session = (await paymentRow(first.invoiceNo)).providerCheckoutRef!;
    gateway.sessions.set(session, sessionPaid(149900));
    await deliver(checkoutEvent(session));

    await expect(callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" })).rejects.toThrow(RENEW_EARLY);
    expect(gateway.recurring).toHaveLength(0);
    await expect(callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "card" })).resolves.toMatchObject({ redirectUrl: expect.any(String) });

    await db.update(workspaces).set({ accessUntil: new Date(Date.now() - DAY) }).where(eq(workspaces.id, team.id));
    await callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel: "maya" });
    expect(gateway.recurring).toHaveLength(1);
  });
});

describe("renewal reminder", () => {
  const ORIGIN = "https://heyitsme.test";
  async function paidPro(channel: "gcash" | "qrph" | "card" | "maya") {
    const user = await makeUser();
    const { invoiceNo } = await callerFor(user).billing.createCheckout({ planCode: "pro", billingCycle: "monthly", channel });
    const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
    if (ref.startsWith("subs_")) {
      gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice(`inv_${ref}`) });
      await deliver(subscriptionEvent(ref));
    } else {
      gateway.sessions.set(ref, { ...sessionPaid(), providerRef: `pay_${ref}` });
      await deliver(checkoutEvent(ref));
    }
    return { user, end: (await proRow(user.id)).currentPeriodEnd };
  }
  const mailsTo = (email: string | null) => vi.mocked(sendMail).mock.calls.filter(([message]) => message.to === email).map(([message]) => message);

  beforeEach(() => vi.mocked(sendMail).mockClear());

  it("reminds a buyer who renews by hand, once, a few days before the plan ends", async () => {
    const { user, end } = await paidPro("gcash");
    vi.mocked(sendMail).mockClear();
    const at = new Date(end.getTime() - 2 * DAY);
    expect((await runPlanCron(db, ORIGIN, at)).renewalReminders).toBe(1);
    expect(mailsTo(user.email)).toEqual([
      expect.objectContaining({ subject: "Your heyitsme Pro plan ends soon", text: expect.stringContaining(`${ORIGIN}/app/billing`) }),
    ]);
    expect((await runPlanCron(db, ORIGIN, new Date(at.getTime() + DAY))).renewalReminders).toBe(0);
    expect(mailsTo(user.email)).toHaveLength(1);
  });

  it("the activation mail promises a reminder only to a buyer who renews by hand", async () => {
    const activationMails = (email: string | null) => mailsTo(email).filter(message => message.subject === "Your heyitsme Pro plan is active");
    const gcash = await paidPro("gcash");
    expect(activationMails(gcash.user.email)).toEqual([expect.objectContaining({ text: expect.stringContaining("We will remind you before then.") })]);

    const maya = await paidPro("maya");
    const ref = (await proRow(maya.user.id)).providerSubscriptionRef!;
    gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice(`inv_renew_${ref}`) });
    await deliver(subscriptionEvent(ref));
    const mayaMails = activationMails(maya.user.email);
    expect(mayaMails).toHaveLength(2);
    for (const message of mayaMails) {
      expect(message.text).toContain("renews by itself each month with Maya");
      expect(message.text).toContain("cancel from Billing");
      expect(message.text).not.toMatch(/remind/i);
    }
  });

  it("does not remind too early, a plan that renews by itself, or a plan the buyer canceled", async () => {
    const { end } = await paidPro("qrph");
    expect((await runPlanCron(db, ORIGIN, new Date(end.getTime() - 5 * DAY))).renewalReminders).toBe(0);
    const maya = await paidPro("maya");
    const canceled = await paidPro("card");
    await callerFor(canceled.user).billing.cancelSubscription();
    vi.mocked(sendMail).mockClear();
    await runPlanCron(db, ORIGIN, new Date(maya.end.getTime() - 2 * DAY));
    expect(mailsTo(maya.user.email)).toHaveLength(0);
    expect(mailsTo(canceled.user.email)).toHaveLength(0);
  });

  it("reminds the owner of a team paid by GCash, not one paid by Maya", async () => {
    Object.assign(ENV, { teamsEnabled: true, teamsBillingEnabled: true });
    const teams = [];
    for (const channel of ["gcash", "maya"] as const) {
      const owner = await makeUser();
      const team = await callerFor(owner).teams.create({ name: `Team ${channel}` });
      const { invoiceNo } = await callerFor(owner).billing.createTeamCheckout({ workspaceId: team.id, channel });
      const ref = (await paymentRow(invoiceNo)).providerCheckoutRef!;
      if (ref.startsWith("subs_")) {
        gateway.subs.set(ref, { status: "active", latestInvoice: paidInvoice(`inv_${ref}`, 149900) });
        await deliver(subscriptionEvent(ref));
      } else {
        gateway.sessions.set(ref, { ...sessionPaid(149900), providerRef: `pay_${ref}` });
        await deliver(checkoutEvent(ref));
      }
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, team.id));
      teams.push({ owner, row });
    }
    vi.mocked(sendMail).mockClear();
    const at = new Date(teams[0].row.accessUntil!.getTime() - 2 * DAY);
    expect((await runPlanCron(db, ORIGIN, at)).renewalReminders).toBe(1);
    expect(mailsTo(teams[0].owner.email)).toEqual([
      expect.objectContaining({ subject: "Team gcash: your heyitsme Teams plan ends soon", text: expect.stringContaining(`${ORIGIN}/app/team/${teams[0].row.id}`) }),
    ]);
    expect(mailsTo(teams[1].owner.email)).toHaveLength(0);
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
