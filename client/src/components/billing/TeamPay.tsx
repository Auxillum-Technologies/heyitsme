import { trpc } from "@/lib/trpc";
import { formatPeso, type PaymentChannel } from "@shared/plans";

export const CHANNEL_LABELS: Record<PaymentChannel, string> = { gcash: "GCash", googlepay: "Google Pay", card: "Card", maya: "Maya", qrph: "QR Ph" };

/** The name a buyer sees for a payment method, with a note when that method renews the plan by itself. */
export function channelLabel(channel: PaymentChannel, autoRenew: readonly PaymentChannel[] = []) {
  return autoRenew.includes(channel) ? `${CHANNEL_LABELS[channel]} (renews each month)` : CHANNEL_LABELS[channel];
}

/**
 * One button per open payment method, for one team's monthly plan. The price shown comes from the server,
 * and the server charges its own figure whatever the browser holds.
 */
export default function TeamPay({ workspaceId, channels, autoRenew = [], priceMinor, renewEarly = false, buttonClass }: {
  workspaceId: number;
  channels: readonly PaymentChannel[];
  autoRenew?: readonly PaymentChannel[];
  priceMinor: number;
  renewEarly?: boolean;
  buttonClass: string;
}) {
  // Auto-renewal charges from the day it starts, so it opens only for a team with no paid time left.
  const shown = renewEarly ? channels.filter(channel => !autoRenew.includes(channel)) : channels;
  const verb = renewEarly ? "Renew early:" : "Pay";
  const checkout = trpc.billing.createTeamCheckout.useMutation();
  const pay = async (channel: PaymentChannel) => {
    try {
      const result = await checkout.mutateAsync({ workspaceId, channel });
      window.location.assign(result.redirectUrl);
    } catch { /* The error shows under the buttons. */ }
  };
  return <>
    {shown.map(channel => (
      <button key={channel} type="button" className={buttonClass} disabled={checkout.isPending} onClick={() => void pay(channel)}>
        {checkout.isPending ? "Opening checkout…" : `${verb} ${formatPeso(priceMinor)} with ${channelLabel(channel, autoRenew)}`}
      </button>
    ))}
    {checkout.error ? <p role="alert" className="plan-error">{checkout.error.message}</p> : null}
  </>;
}
