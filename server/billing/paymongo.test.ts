import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PayMongoProvider, verifyPaymongoSignature } from "./paymongo";
import { PaymentProviderError } from "./provider";

// Vector made outside the code under test:
// printf '%s' '1700000000.<BODY>' | openssl dgst -sha256 -hmac 'whsk_test_secret'
const SECRET = "whsk_test_secret";
const BODY = '{"data":{"id":"evt_1","attributes":{"type":"checkout_session.payment.paid"}}}';
const T = 1700000000;
const SIG = "034c62f2e6ba07451566eaca6c5b7cedcc16dd76138ac2b341889082ef281255";
const AT = new Date(T * 1000 + 30_000);

describe("verifyPaymongoSignature", () => {
  it("accepts a test-mode signature made with the webhook secret", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG},li=`, SECRET, "test", AT)).toBe(true);
  });

  it("accepts the same signature in the live slot for a live endpoint", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T},te=,li=${SIG}`, SECRET, "live", AT)).toBe(true);
  });

  it("rejects a test-mode signature sent to a live endpoint", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG},li=`, SECRET, "live", AT)).toBe(false);
  });

  it("rejects a body changed after signing", () => {
    expect(verifyPaymongoSignature(BODY.replace("evt_1", "evt_2"), `t=${T},te=${SIG},li=`, SECRET, "test", AT)).toBe(false);
  });

  it("rejects another secret", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG},li=`, "whsk_other", "test", AT)).toBe(false);
  });

  it("rejects a changed timestamp", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T + 1},te=${SIG},li=`, SECRET, "test", AT)).toBe(false);
  });

  it("rejects a delivery older than five minutes", () => {
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG},li=`, SECRET, "test", new Date(T * 1000 + 301_000))).toBe(false);
  });

  it("rejects a missing or malformed header and an empty secret", () => {
    expect(verifyPaymongoSignature(BODY, undefined, SECRET, "test", AT)).toBe(false);
    expect(verifyPaymongoSignature(BODY, "garbage", SECRET, "test", AT)).toBe(false);
    expect(verifyPaymongoSignature(BODY, `te=${SIG}`, SECRET, "test", AT)).toBe(false);
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG.slice(2)},li=`, SECRET, "test", AT)).toBe(false);
    expect(verifyPaymongoSignature(BODY, `t=${T},te=${SIG},li=`, "", "test", AT)).toBe(false);
  });
});

const KEY = "sk_test_abc123";
const AUTH = `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`;

type Call = { url: string; method: string; auth: string | null; body: unknown };
/** A fetch that records each request and answers from a queue of [status, body] pairs. */
function fakeFetch(...answers: [number, unknown][]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    const [status, body] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

const paymongo = (fetchImpl: typeof fetch) => new PayMongoProvider({ secretKey: KEY, webhookSecret: SECRET, mode: "test", fetchImpl });

const order = {
  invoiceNo: "HIM123",
  amountMinor: 29900,
  currency: "PHP" as const,
  description: "heyitsme Pro (monthly)",
  channel: "gcash" as const,
  frontendReturnUrl: "https://heyitsme.fyi/api/payments/paymongo/return?invoice=HIM123",
  backendReturnUrl: "https://heyitsme.fyi/api/payments/paymongo/webhook",
};

describe("PayMongoProvider.createCheckout", () => {
  it("opens a hosted Checkout Session for the server price, our invoice number and the buyer's channel", async () => {
    const { calls, impl } = fakeFetch([200, { data: { id: "cs_abc", attributes: { checkout_url: "https://checkout.paymongo.com/cs_abc" } } }]);
    const session = await paymongo(impl).createCheckout(order);
    expect(calls[0]).toMatchObject({ url: "https://api.paymongo.com/v1/checkout_sessions", method: "POST", auth: AUTH });
    expect(calls[0].body).toEqual({
      data: {
        attributes: {
          line_items: [{ name: "heyitsme Pro (monthly)", amount: 29900, currency: "PHP", quantity: 1 }],
          payment_method_types: ["gcash"],
          reference_number: "HIM123",
          description: "heyitsme Pro (monthly)",
          success_url: order.frontendReturnUrl,
          cancel_url: order.frontendReturnUrl,
          metadata: { invoice_no: "HIM123" },
        },
      },
    });
    expect(session).toEqual({ redirectUrl: "https://checkout.paymongo.com/cs_abc", providerToken: "cs_abc" });
  });

  it("names each channel with PayMongo's payment method type", async () => {
    const types: Record<string, string[]> = { gcash: ["gcash"], qrph: ["qrph"], maya: ["paymaya"], card: ["card"] };
    for (const [channel, expected] of Object.entries(types)) {
      const { calls, impl } = fakeFetch([200, { data: { id: "cs_1", attributes: { checkout_url: "https://checkout.paymongo.com/cs_1" } } }]);
      await paymongo(impl).createCheckout({ ...order, channel: channel as typeof order.channel });
      expect((calls[0].body as { data: { attributes: { payment_method_types: string[] } } }).data.attributes.payment_method_types).toEqual(expected);
    }
  });

  it("refuses a channel PayMongo does not take, before any request", async () => {
    const { calls, impl } = fakeFetch();
    await expect(paymongo(impl).createCheckout({ ...order, channel: "googlepay" })).rejects.toMatchObject({ code: "not_supported" });
    expect(calls).toHaveLength(0);
  });

  it("turns an API error or a non-https checkout link into a provider error", async () => {
    const rejected = fakeFetch([400, { errors: [{ code: "parameter_invalid", detail: "bad" }] }]);
    await expect(paymongo(rejected.impl).createCheckout(order)).rejects.toBeInstanceOf(PaymentProviderError);
    const insecure = fakeFetch([200, { data: { id: "cs_1", attributes: { checkout_url: "http://evil.test/cs_1" } } }]);
    await expect(paymongo(insecure.impl).createCheckout(order)).rejects.toMatchObject({ code: "rejected" });
  });

  it("needs a secret key", () => {
    expect(() => new PayMongoProvider({ secretKey: "", webhookSecret: SECRET, mode: "test" })).toThrow(PaymentProviderError);
  });
});

const sessionBody = (attributes: Record<string, unknown>) => ({ data: { id: "cs_abc", type: "checkout_session", attributes: { reference_number: "HIM123", status: "active", payments: [], ...attributes } } });
const paid = { id: "pay_1", type: "payment", attributes: { amount: 29900, currency: "PHP", status: "paid", source: { type: "gcash" } } };

describe("PayMongoProvider.getPaymentStatus for a Checkout Session", () => {
  it("asks PayMongo for the session and reports its paid payment", async () => {
    const { calls, impl } = fakeFetch([200, sessionBody({ payments: [paid] })]);
    const result = await paymongo(impl).getPaymentStatus("HIM123", "cs_abc");
    expect(calls[0]).toMatchObject({ url: "https://api.paymongo.com/v1/checkout_sessions/cs_abc", method: "GET", auth: AUTH });
    expect(result).toEqual({ invoiceNo: "HIM123", status: "succeeded", amountMinor: 29900, currency: "PHP", providerRef: "pay_1", channelCode: "gcash", code: "paid" });
  });

  it("is pending while the session is open and unpaid, also after a failed try", async () => {
    const open = fakeFetch([200, sessionBody({})]);
    expect(await paymongo(open.impl).getPaymentStatus("HIM123", "cs_abc")).toMatchObject({ status: "pending", providerRef: null });
    const declined = { ...paid, attributes: { ...paid.attributes, status: "failed" } };
    const retry = fakeFetch([200, sessionBody({ payments: [declined] })]);
    expect(await paymongo(retry.impl).getPaymentStatus("HIM123", "cs_abc")).toMatchObject({ status: "pending" });
  });

  it("fails once the session has expired unpaid", async () => {
    const { impl } = fakeFetch([200, sessionBody({ status: "expired" })]);
    expect(await paymongo(impl).getPaymentStatus("HIM123", "cs_abc")).toMatchObject({ status: "failed", code: "expired" });
  });

  it("refuses a session that belongs to another invoice", async () => {
    const { impl } = fakeFetch([200, sessionBody({ reference_number: "HIM999", payments: [paid] })]);
    await expect(paymongo(impl).getPaymentStatus("HIM123", "cs_abc")).rejects.toMatchObject({ code: "mismatch" });
  });

  it("refuses to guess without the session id, and never sends an unsafe id", async () => {
    const { calls, impl } = fakeFetch();
    await expect(paymongo(impl).getPaymentStatus("HIM123")).rejects.toMatchObject({ code: "not_found" });
    await expect(paymongo(impl).getPaymentStatus("HIM123", "cs_abc/../refunds")).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(0);
  });
});

describe("PayMongoProvider.createRecurringSubscription", () => {
  const maya = { ...order, channel: "maya" as const, customer: { email: "ada@example.com", name: "Ada Lovelace", providerCustomerRef: null } };
  const answers = (): [number, unknown][] => [
    [200, { data: { id: "cus_1", attributes: {} } }],
    [200, { data: { id: "plan_1", attributes: {} } }],
    [200, { data: { id: "subs_1", attributes: { status: "incomplete", latest_invoice: { id: "inv_1", payment_intent: { id: "pi_1", status: "awaiting_payment_method" } } } } }],
    [200, { data: { id: "pm_1", attributes: { type: "paymaya" } } }],
    [200, { data: { id: "pi_1", attributes: { status: "awaiting_next_action", next_action: { type: "redirect", redirect: { url: "https://payments.maya.ph/authorize/abc" } } } } }],
  ];

  it("makes a customer, a monthly plan at the server price and a subscription, then sends the buyer to Maya", async () => {
    const { calls, impl } = fakeFetch(...answers());
    const session = await paymongo(impl).createRecurringSubscription(maya);
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.paymongo.com/v1/customers",
      "POST https://api.paymongo.com/v1/subscriptions/plans",
      "POST https://api.paymongo.com/v1/subscriptions",
      "POST https://api.paymongo.com/v1/payment_methods",
      "POST https://api.paymongo.com/v1/payment_intents/pi_1/attach",
    ]);
    expect(calls.every(call => call.auth === AUTH)).toBe(true);
    const attributes = calls.map(call => (call.body as { data: { attributes: unknown } }).data.attributes);
    expect(attributes[0]).toEqual({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", default_device: "email" });
    expect(attributes[1]).toEqual({ name: "heyitsme Pro (monthly)", description: "heyitsme Pro (monthly)", amount: 29900, currency: "PHP", interval: "monthly", interval_count: 1 });
    expect(attributes[2]).toEqual({ plan_id: "plan_1", customer_id: "cus_1" });
    expect(attributes[3]).toEqual({ type: "paymaya", billing: { name: "Ada Lovelace", email: "ada@example.com" } });
    expect(attributes[4]).toEqual({ payment_method: "pm_1", return_url: order.frontendReturnUrl });
    expect(session).toEqual({ redirectUrl: "https://payments.maya.ph/authorize/abc", providerToken: "subs_1", providerCustomerRef: "cus_1" });
  });

  it("reuses the buyer's PayMongo customer", async () => {
    const { calls, impl } = fakeFetch(...answers().slice(1));
    const session = await paymongo(impl).createRecurringSubscription({ ...maya, customer: { ...maya.customer, providerCustomerRef: "cus_9" } });
    expect(calls[0].url).toBe("https://api.paymongo.com/v1/subscriptions/plans");
    expect((calls[1].body as { data: { attributes: unknown } }).data.attributes).toEqual({ plan_id: "plan_1", customer_id: "cus_9" });
    expect(session.providerCustomerRef).toBe("cus_9");
  });

  it("auto-renews Maya only: cards and wallets pay one month at a time", async () => {
    const { calls, impl } = fakeFetch();
    for (const channel of ["card", "gcash", "qrph"] as const) {
      await expect(paymongo(impl).createRecurringSubscription({ ...maya, channel })).rejects.toMatchObject({ code: "not_supported" });
    }
    await expect(paymongo(impl).createRecurringSubscription({ ...maya, customer: undefined })).rejects.toMatchObject({ code: "not_supported" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a Maya link that is not https", async () => {
    const bad = answers();
    bad[4] = [200, { data: { id: "pi_1", attributes: { next_action: { type: "redirect", redirect: { url: "http://evil.test" } } } } }];
    const { impl } = fakeFetch(...bad);
    await expect(paymongo(impl).createRecurringSubscription(maya)).rejects.toMatchObject({ code: "rejected" });
  });
});

const subscriptionBody = (status: string, invoice: Record<string, unknown> | null) => ({
  data: { id: "subs_1", type: "subscription", attributes: { status, latest_invoice: invoice } },
});
const paidInvoice = { id: "inv_2", amount: 29900, currency: "PHP", status: "paid", payment_intent: { id: "pi_2", status: "succeeded" } };

describe("PayMongoProvider subscription read back", () => {
  it("reads the subscription status and its latest invoice from PayMongo", async () => {
    const { calls, impl } = fakeFetch([200, subscriptionBody("past_due", { ...paidInvoice, id: "inv_3", status: "open" })]);
    expect(await paymongo(impl).getSubscription("subs_1")).toEqual({
      status: "past_due",
      latestInvoice: { ref: "inv_3", paid: false, amountMinor: 29900, currency: "PHP" },
    });
    expect(calls[0]).toMatchObject({ url: "https://api.paymongo.com/v1/subscriptions/subs_1", method: "GET", auth: AUTH });
  });

  it("names every PayMongo status the way billing does", async () => {
    const statuses: Record<string, string> = {
      active: "active",
      past_due: "past_due",
      unpaid: "unpaid",
      cancelled: "canceled",
      incomplete: "incomplete",
      incomplete_cancelled: "incomplete",
      something_new: "unknown",
    };
    for (const [given, expected] of Object.entries(statuses)) {
      const { impl } = fakeFetch([200, subscriptionBody(given, null)]);
      expect((await paymongo(impl).getSubscription("subs_1")).status).toBe(expected);
    }
  });

  it("settles the first payment of a subscription from its paid invoice", async () => {
    const { impl } = fakeFetch([200, subscriptionBody("active", paidInvoice)]);
    expect(await paymongo(impl).getPaymentStatus("HIM123", "subs_1")).toEqual({
      invoiceNo: "HIM123", status: "succeeded", amountMinor: 29900, currency: "PHP", providerRef: "inv_2", channelCode: "paymaya", code: "paid",
    });
  });

  it("keeps the first payment pending until it is paid, and fails it after PayMongo gives up", async () => {
    const waiting = fakeFetch([200, subscriptionBody("incomplete", { ...paidInvoice, status: "open" })]);
    expect(await paymongo(waiting.impl).getPaymentStatus("HIM123", "subs_1")).toMatchObject({ status: "pending", providerRef: null });
    const gone = fakeFetch([200, subscriptionBody("incomplete_cancelled", { ...paidInvoice, status: "void" })]);
    expect(await paymongo(gone.impl).getPaymentStatus("HIM123", "subs_1")).toMatchObject({ status: "failed", code: "incomplete_cancelled" });
  });
});

describe("PayMongoProvider.cancelSubscription", () => {
  it("cancels the subscription at PayMongo", async () => {
    const { calls, impl } = fakeFetch([200, subscriptionBody("cancelled", null)]);
    await paymongo(impl).cancelSubscription("subs_1");
    expect(calls).toEqual([{ url: "https://api.paymongo.com/v1/subscriptions/subs_1/cancel", method: "POST", auth: AUTH, body: { data: { attributes: { cancellation_reason: "other" } } } }]);
  });

  it("reports a failed cancel, so the plan is not shown as stopped while PayMongo still charges", async () => {
    const { impl } = fakeFetch([500, {}]);
    await expect(paymongo(impl).cancelSubscription("subs_1")).rejects.toBeInstanceOf(PaymentProviderError);
  });
});

describe("PayMongoProvider.refundPayment", () => {
  it("refunds all or part of a payment by its PayMongo payment id", async () => {
    const { calls, impl } = fakeFetch([200, { data: { id: "ref_1", attributes: { status: "pending" } } }]);
    await paymongo(impl).refundPayment("pay_1", 15000);
    expect(calls).toEqual([{ url: "https://api.paymongo.com/v1/refunds", method: "POST", auth: AUTH, body: { data: { attributes: { amount: 15000, payment_id: "pay_1", reason: "others" } } } }]);
  });

  it("refuses an amount that is not whole centavos above zero, and anything that is not a payment id", async () => {
    const { calls, impl } = fakeFetch();
    for (const amount of [0, -100, 10.5]) await expect(paymongo(impl).refundPayment("pay_1", amount)).rejects.toMatchObject({ code: "bad_request" });
    // A renewal is stored by its invoice id. Refund it from the PayMongo dashboard.
    await expect(paymongo(impl).refundPayment("inv_1", 29900)).rejects.toMatchObject({ code: "not_supported" });
    expect(calls).toHaveLength(0);
  });

  it("reports a refund PayMongo refuses", async () => {
    const { impl } = fakeFetch([400, { errors: [{ code: "refund_amount_exceeds_payment" }] }]);
    await expect(paymongo(impl).refundPayment("pay_1", 99999)).rejects.toMatchObject({ code: "rejected" });
  });
});

/** Signs a body the way PayMongo does. The algorithm itself is pinned by the openssl vector above. */
function signPaymongo(body: string, secret = SECRET, at = new Date()) {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},te=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")},li=`;
}
const event = (type: string, data: Record<string, unknown>) => JSON.stringify({ data: { id: "evt_1", type: "event", attributes: { type, livemode: false, data } } });

describe("PayMongoProvider.parseWebhook", () => {
  const provider = paymongo(fakeFetch().impl);

  it("points a paid checkout at its session, to be read back", () => {
    const body = event("checkout_session.payment.paid", { id: "cs_abc", type: "checkout_session", attributes: { reference_number: "HIM123" } });
    expect(provider.parseWebhook(body, signPaymongo(body))).toEqual({ kind: "checkout", ref: "cs_abc" });
  });

  it("points every subscription and invoice event at its subscription", () => {
    for (const type of ["subscription.activated", "subscription.past_due", "subscription.unpaid", "subscription.updated"]) {
      const body = event(type, { id: "subs_1", type: "subscription", attributes: { status: "active" } });
      expect(provider.parseWebhook(body, signPaymongo(body))).toEqual({ kind: "subscription", ref: "subs_1" });
    }
    for (const type of ["subscription.invoice.paid", "subscription.invoice.payment_failed"]) {
      const body = event(type, { id: "inv_1", type: "invoice", attributes: { resource_id: "subs_1", status: "paid" } });
      expect(provider.parseWebhook(body, signPaymongo(body))).toEqual({ kind: "subscription", ref: "subs_1" });
    }
  });

  it("acknowledges an event it does not act on", () => {
    const body = event("payment.paid", { id: "pay_1", type: "payment", attributes: {} });
    expect(provider.parseWebhook(body, signPaymongo(body))).toEqual({ kind: "ignored", type: "payment.paid" });
  });

  it("returns null for a bad signature or a body that is not an event", () => {
    const body = event("checkout_session.payment.paid", { id: "cs_abc", type: "checkout_session", attributes: {} });
    expect(provider.parseWebhook(body, signPaymongo(body, "whsk_other"))).toBeNull();
    expect(provider.parseWebhook(body, undefined)).toBeNull();
    expect(provider.parseWebhook("not json", signPaymongo("not json"))).toBeNull();
    const unsafe = event("checkout_session.payment.paid", { id: "cs_abc/../x", type: "checkout_session", attributes: {} });
    expect(provider.parseWebhook(unsafe, signPaymongo(unsafe))).toBeNull();
  });
});
