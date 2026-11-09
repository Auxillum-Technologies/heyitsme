import type { PaymentChannel } from "@shared/plans";

/** The upgrade dialog's note under the pay button, for the payment channel the buyer picked. */
export function upgradeFootnote(selected: PaymentChannel | undefined, autoRenewChannels: readonly PaymentChannel[]): string {
  if (selected && autoRenewChannels.includes(selected)) {
    return "Your monthly access starts after payment verification. Renews by itself each month with Maya. Cancel any time from Billing.";
  }
  return "Your monthly access starts after payment verification. Renew from Billing before it ends.";
}
