import type { PaymentChannel } from "@shared/plans";

// Billing logic talks to this interface only, so another gateway can be added without touching it.
// Every amount is integer centavos. Adapters convert to the gateway's own format.

export type CheckoutRequest = {
  invoiceNo: string;
  amountMinor: number;
  currency: "PHP";
  description: string;
  channel: PaymentChannel;
  /** Browser lands here after the hosted page. Navigation only: it never grants anything. */
  frontendReturnUrl: string;
  /** Gateway posts the signed result here. */
  backendReturnUrl: string;
  /** The buyer, for gateways that keep a customer for auto-renewal. */
  customer?: { email: string; name: string | null; providerCustomerRef: string | null };
};

export type CheckoutSession = {
  redirectUrl: string;
  /** The gateway's id for what was opened: a checkout session, or a subscription for auto-renewal. */
  providerToken: string;
  /** The gateway's customer id, saved on the billing account so the next checkout reuses it. */
  providerCustomerRef?: string;
};

export type PaymentResult = {
  invoiceNo: string;
  status: "succeeded" | "failed" | "pending";
  amountMinor: number;
  currency: string;
  providerRef: string | null;
  channelCode: string | null;
  /** Gateway code, safe to store. Never shown raw to visitors. */
  code: string;
  /** The gateway subscription this payment belongs to. Settling it links the plan to that subscription. */
  providerSubscriptionRef?: string | null;
};

/** A gateway subscription as the gateway reports it. Statuses use billing's own names. */
export type SubscriptionState = {
  status: "active" | "past_due" | "unpaid" | "canceled" | "incomplete" | "unknown";
  latestInvoice: { ref: string; paid: boolean; amountMinor: number; currency: string } | null;
};

/** What a verified webhook asks for: read this object back from the gateway, or nothing. */
export type ProviderEvent =
  | { kind: "checkout"; ref: string }
  | { kind: "subscription"; ref: string }
  | { kind: "ignored"; type: string };

export class PaymentProviderError extends Error {
  constructor(message: string, readonly code = "provider_error") {
    super(message);
  }
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  createOneTimePayment(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Auto-renewal. Only for channels in autoRenewChannels(): Maya on PayMongo, once Subscriptions is on. */
  createRecurringSubscription(request: CheckoutRequest): Promise<CheckoutSession>;
  cancelSubscription(providerSubscriptionRef: string): Promise<void>;
  /** Asks the gateway directly. The source of truth for renewals and for past-due and unpaid plans. */
  getSubscription(providerSubscriptionRef: string): Promise<SubscriptionState>;
  /** Verifies a gateway callback body. Returns null when it is unsigned, forged, or not for this merchant. */
  verifyCallback(body: unknown): Promise<PaymentResult | null>;
  /**
   * Gateways with signed webhooks (PayMongo) check the signature over the raw body. Null when it is unsigned,
   * forged or unreadable. The event is only a hint: the handler reads the object back before it acts.
   */
  parseWebhook?(rawBody: string, signatureHeader: string | undefined): ProviderEvent | null;
  /**
   * Asks the gateway directly. The source of truth before any entitlement changes. A gateway that looks a
   * payment up by its own id (PayMongo) gets the id saved when checkout opened, `payments.providerCheckoutRef`.
   */
  getPaymentStatus(invoiceNo: string, providerCheckoutRef?: string | null): Promise<PaymentResult>;
  /** Refunds a settled payment by the gateway reference stored in `payments.providerInvoiceRef`. */
  refundPayment(providerPaymentRef: string, amountMinor: number): Promise<void>;
}
