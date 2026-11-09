import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../_core/context";
import { billingAccounts, payments, users } from "../../drizzle/schema";
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
  parseWebhook(rawBody: string, header: string | undefined): ProviderEvent | null {
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
