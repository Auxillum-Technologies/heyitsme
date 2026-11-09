import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentChannel } from "@shared/plans";
import { PaymentProviderError, type CheckoutRequest, type CheckoutSession, type PaymentProvider, type PaymentResult, type ProviderEvent, type SubscriptionState } from "./provider";

// PayMongo adapter: hosted Checkout Sessions for one-time payments (GCash, QR Ph, Maya, card) and Subscriptions
// for Maya auto-renewal. Contract read 2026-11-09 from docs.paymongo.com (Subscriptions guide, "Securing a
// webhook", Checkout Session, Refunds, Subscription and Invoice resources). Subscriptions need PayMongo support
// to enable them on the account, so PAYMONGO_SUBSCRIPTIONS_ENABLED stays off until they do.

/** Deliveries older than this are refused, so a captured request cannot be replayed later. */
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

/**
 * Checks a `Paymongo-Signature` header (`t=<unix>,te=<test sig>,li=<live sig>`): HMAC-SHA256 of
 * `t + "." + rawBody` with the webhook secret, compared with `te` for a test endpoint or `li` for a live one.
 */
export function verifyPaymongoSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  mode: "test" | "live",
  now = new Date()
): boolean {
  if (!secret || typeof header !== "string" || header.length > 512) return false;
  const parts = new Map(
    header.split(",").map(part => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    })
  );
  const t = parts.get("t") ?? "";
  const given = parts.get(mode === "live" ? "li" : "te") ?? "";
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(given)) return false;
  if (Math.abs(now.getTime() - Number(t) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

const API = "https://api.paymongo.com/v1";
/** PayMongo ids (cs_, subs_, pay_, inv_, cus_, plan_, pi_, pm_) are letters, digits and underscores. */
const SAFE_ID = /^[A-Za-z0-9_]{3,128}$/;

/** PayMongo payment method type for each channel it takes. Google Pay runs on 2C2P only. */
export const PAYMONGO_METHOD_TYPES: Partial<Record<PaymentChannel, string>> = {
  gcash: "gcash",
  qrph: "qrph",
  maya: "paymaya",
  card: "card",
};

export type PayMongoConfig = {
  secretKey: string;
  webhookSecret: string;
  /** Test keys and test webhooks sign with `te`, live ones with `li`. */
  mode: "test" | "live";
  fetchImpl?: typeof fetch;
};

type Resource = { id?: unknown; attributes?: Record<string, unknown> };

const idOf = (resource: Resource) => {
  if (typeof resource.id !== "string" || !SAFE_ID.test(resource.id)) throw new PaymentProviderError("PayMongo answered without an id", "rejected");
  return resource.id;
};

const SUBSCRIPTION_STATUS: Record<string, SubscriptionState["status"]> = {
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  cancelled: "canceled",
  incomplete: "incomplete",
  incomplete_cancelled: "incomplete",
};

function subscriptionState(subscription: Resource): SubscriptionState {
  const invoice = subscription.attributes?.latest_invoice as Record<string, unknown> | null | undefined;
  return {
    status: SUBSCRIPTION_STATUS[String(subscription.attributes?.status)] ?? "unknown",
    latestInvoice:
      invoice && typeof invoice.id === "string" && SAFE_ID.test(invoice.id)
        ? { ref: invoice.id, paid: invoice.status === "paid", amountMinor: Number(invoice.amount), currency: String(invoice.currency ?? "") }
        : null,
  };
}

const methodType = (channel: PaymentChannel) => {
  const type = PAYMONGO_METHOD_TYPES[channel];
  if (!type) throw new PaymentProviderError(`PayMongo does not take ${channel}`, "not_supported");
  return type;
};

export class PayMongoProvider implements PaymentProvider {
  readonly name = "paymongo";
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PayMongoConfig) {
    if (!config.secretKey) throw new PaymentProviderError("PayMongo secret key is required", "not_configured");
    this.auth = `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** One API call. Errors come back as `{ errors: [{ code, detail }] }`; only the code is kept. */
  private async call(method: "GET" | "POST", path: string, attributes?: Record<string, unknown>): Promise<Resource> {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", ...(attributes ? { "Content-Type": "application/json" } : {}) },
      body: attributes ? JSON.stringify({ data: { attributes } }) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { data?: Resource; errors?: { code?: string }[] } | null;
    if (!response.ok || !body?.data) {
      const code = body?.errors?.[0]?.code ?? `http_${response.status}`;
      throw new PaymentProviderError(`PayMongo ${method} ${path.split("/")[1]} failed (${code})`, "rejected");
    }
    return body.data;
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const type = methodType(request.channel);
    const session = await this.call("POST", "/checkout_sessions", {
      line_items: [{ name: request.description, amount: request.amountMinor, currency: request.currency, quantity: 1 }],
      payment_method_types: [type],
      reference_number: request.invoiceNo,
      description: request.description,
      success_url: request.frontendReturnUrl,
      cancel_url: request.frontendReturnUrl,
      metadata: { invoice_no: request.invoiceNo },
    });
    const url = session.attributes?.checkout_url;
    if (typeof session.id !== "string" || typeof url !== "string" || !url.startsWith("https://")) {
      throw new PaymentProviderError("PayMongo did not open a checkout", "rejected");
    }
    return { redirectUrl: url, providerToken: session.id };
  }

  createOneTimePayment(request: CheckoutRequest) {
    return this.createCheckout(request);
  }

  /**
   * Maya auto-renewal (D1: cards pay one month at a time on the hosted page, so no card is typed on heyitsme).
   * PayMongo makes the first invoice with the subscription. Attaching a Maya payment method to that invoice's
   * payment intent gives the page where the buyer authorizes Maya, and that also stores Maya for renewals.
   */
  async createRecurringSubscription(request: CheckoutRequest): Promise<CheckoutSession> {
    const customer = request.customer;
    if (request.channel !== "maya" || !customer?.email) {
      throw new PaymentProviderError(`PayMongo auto-renewal is not offered for ${request.channel}`, "not_supported");
    }
    const name = customer.name?.trim() || "";
    const [first, ...rest] = name.split(/\s+/);
    const customerId =
      customer.providerCustomerRef ??
      idOf(
        await this.call("POST", "/customers", {
          first_name: (first || "heyitsme").slice(0, 100),
          last_name: (rest.join(" ") || "member").slice(0, 100),
          email: customer.email,
          default_device: "email",
        })
      );
    const plan = await this.call("POST", "/subscriptions/plans", {
      name: request.description,
      description: request.description,
      amount: request.amountMinor,
      currency: request.currency,
      interval: "monthly",
      interval_count: 1,
    });
    const subscription = await this.call("POST", "/subscriptions", { plan_id: idOf(plan), customer_id: customerId });
    const invoice = subscription.attributes?.latest_invoice as { payment_intent?: { id?: unknown } } | undefined;
    const intentId = invoice?.payment_intent?.id;
    if (typeof intentId !== "string" || !SAFE_ID.test(intentId)) throw new PaymentProviderError("PayMongo subscription has no first payment", "rejected");
    const method = await this.call("POST", "/payment_methods", { type: "paymaya", billing: { name: name || customer.email, email: customer.email } });
    const intent = await this.call("POST", `/payment_intents/${intentId}/attach`, { payment_method: idOf(method), return_url: request.frontendReturnUrl });
    const nextAction = intent.attributes?.next_action as { redirect?: { url?: unknown } } | undefined;
    const url = nextAction?.redirect?.url;
    if (typeof url !== "string" || !url.startsWith("https://")) throw new PaymentProviderError("PayMongo did not open Maya", "rejected");
    return { redirectUrl: url, providerToken: idOf(subscription), providerCustomerRef: customerId };
  }

  /** PayMongo stops the subscription at once. The paid period still runs to its end in heyitsme. */
  async cancelSubscription(providerSubscriptionRef: string): Promise<void> {
    if (!SAFE_ID.test(providerSubscriptionRef) || !providerSubscriptionRef.startsWith("subs_")) {
      throw new PaymentProviderError("Not a PayMongo subscription id", "not_found");
    }
    await this.call("POST", `/subscriptions/${providerSubscriptionRef}/cancel`, { cancellation_reason: "other" });
  }

  async getSubscription(providerSubscriptionRef: string): Promise<SubscriptionState> {
    if (!SAFE_ID.test(providerSubscriptionRef) || !providerSubscriptionRef.startsWith("subs_")) {
      throw new PaymentProviderError("Not a PayMongo subscription id", "not_found");
    }
    return subscriptionState(await this.call("GET", `/subscriptions/${providerSubscriptionRef}`));
  }

  /** PayMongo sends webhooks, not 2C2P-style callbacks. See parseWebhook. */
  async verifyCallback(): Promise<PaymentResult | null> {
    return null;
  }

  parseWebhook(rawBody: string, signatureHeader: string | undefined): ProviderEvent | null {
    if (!verifyPaymongoSignature(rawBody, signatureHeader, this.config.webhookSecret, this.config.mode)) return null;
    let type: unknown;
    let object: Resource | undefined;
    try {
      const attributes = (JSON.parse(rawBody) as { data?: { attributes?: { type?: unknown; data?: Resource } } }).data?.attributes;
      type = attributes?.type;
      object = attributes?.data;
    } catch {
      return null;
    }
    if (typeof type !== "string") return null;
    const id = (value: unknown) => (typeof value === "string" && SAFE_ID.test(value) ? value : null);
    if (type === "checkout_session.payment.paid") {
      const ref = id(object?.id);
      return ref ? { kind: "checkout", ref } : null;
    }
    if (type.startsWith("subscription.invoice.")) {
      const ref = id(object?.attributes?.resource_id);
      return ref ? { kind: "subscription", ref } : null;
    }
    if (type.startsWith("subscription.")) {
      const ref = id(object?.id);
      return ref ? { kind: "subscription", ref } : null;
    }
    return { kind: "ignored", type: type.slice(0, 64) };
  }

  async getPaymentStatus(invoiceNo: string, providerCheckoutRef?: string | null): Promise<PaymentResult> {
    if (providerCheckoutRef?.startsWith("subs_")) return this.firstSubscriptionPayment(invoiceNo, providerCheckoutRef);
    if (!providerCheckoutRef || !SAFE_ID.test(providerCheckoutRef) || !providerCheckoutRef.startsWith("cs_")) {
      throw new PaymentProviderError("No PayMongo checkout is recorded for this invoice", "not_found");
    }
    const session = await this.call("GET", `/checkout_sessions/${providerCheckoutRef}`);
    const attributes = session.attributes ?? {};
    if (attributes.reference_number !== invoiceNo) throw new PaymentProviderError("PayMongo session belongs to another invoice", "mismatch");
    const payments = Array.isArray(attributes.payments) ? (attributes.payments as Resource[]) : [];
    const payment = payments.find(item => item.attributes?.status === "paid");
    if (payment) {
      const source = payment.attributes?.source as { type?: unknown } | undefined;
      return {
        invoiceNo,
        status: "succeeded",
        amountMinor: Number(payment.attributes?.amount),
        currency: String(payment.attributes?.currency ?? ""),
        providerRef: typeof payment.id === "string" ? payment.id : null,
        channelCode: typeof source?.type === "string" ? source.type : null,
        code: "paid",
      };
    }
    // A declined try leaves the session open for another one, so only an expired session is a failure.
    const expired = attributes.status === "expired";
    return { invoiceNo, status: expired ? "failed" : "pending", amountMinor: 0, currency: "PHP", providerRef: null, channelCode: null, code: expired ? "expired" : "open" };
  }

  /** The first payment of an auto-renewal is the subscription's first invoice. */
  private async firstSubscriptionPayment(invoiceNo: string, providerSubscriptionRef: string): Promise<PaymentResult> {
    const raw = await this.call("GET", `/subscriptions/${providerSubscriptionRef}`);
    const invoice = subscriptionState(raw).latestInvoice;
    if (invoice?.paid) {
      return { invoiceNo, status: "succeeded", amountMinor: invoice.amountMinor, currency: invoice.currency, providerRef: invoice.ref, channelCode: "paymaya", code: "paid" };
    }
    const gone = raw.attributes?.status === "incomplete_cancelled";
    return { invoiceNo, status: gone ? "failed" : "pending", amountMinor: 0, currency: "PHP", providerRef: null, channelCode: null, code: gone ? "incomplete_cancelled" : "open" };
  }

  /** Full or partial refund (D5: the call only, no screen). PayMongo checks the total against the payment. */
  async refundPayment(providerPaymentRef: string, amountMinor: number): Promise<void> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new PaymentProviderError("Refund amount must be whole centavos", "bad_request");
    if (!SAFE_ID.test(providerPaymentRef) || !providerPaymentRef.startsWith("pay_")) {
      throw new PaymentProviderError("Only a PayMongo payment id can be refunded by API. Refund a renewal in the PayMongo dashboard.", "not_supported");
    }
    await this.call("POST", "/refunds", { amount: amountMinor, payment_id: providerPaymentRef, reason: "others" });
  }
}
