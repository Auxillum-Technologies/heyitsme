import type { MailMessage } from "../_core/mail";

const dateText = (date: Date) => date.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Manila" });

const plain = (to: string, subject: string, lines: string[]): MailMessage => ({
  to,
  subject,
  text: lines.join("\n"),
  html: lines.map((line) => (line ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "")).join(""),
});

/** Sent once to the owner of a team that was free, when Teams starts being sold. */
export function teamFreeEndingMail(input: { to: string; teamName: string; endsAt: Date; holdFrom: Date; teamUrl: string }): MailMessage {
  return plain(input.to, `${input.teamName}: heyitsme Teams is now a paid plan`, [
    `heyitsme Teams is now a paid plan. Your team, ${input.teamName}, stays free until ${dateText(input.endsAt)}.`,
    "",
    `To keep it running, pay for its plan on the team's Billing tab before then. If the plan is not paid by ${dateText(input.holdFrom)}, the team is put on hold: its company cards, event pages and review pages are paused, and the team cannot be opened or downloaded from until it is paid.`,
    "",
    "Nothing is deleted. Paying brings everything back as it was.",
    "",
    `Open your team: ${input.teamUrl}`,
  ]);
}

/** Sent once when a team's plan has ended, before its hold starts. */
export function teamPlanEndedMail(input: { to: string; teamName: string; holdFrom: Date; teamUrl: string }): MailMessage {
  return plain(input.to, `${input.teamName}: your heyitsme Teams plan has ended`, [
    `The plan for your team, ${input.teamName}, has ended.`,
    "",
    `Renew it on the team's Billing tab by ${dateText(input.holdFrom)}. After that the team is put on hold: its company cards, event pages and review pages are paused, and the team cannot be opened or downloaded from until it is paid.`,
    "",
    "Nothing is deleted. Paying brings everything back as it was.",
    "",
    `Open your team: ${input.teamUrl}`,
  ]);
}

/** Sent once when an account's Pro has ended, before its cards are paused. */
export function proEndedMail(input: { to: string; holdFrom: Date; billingUrl: string }): MailMessage {
  return plain(input.to, "Your heyitsme Pro plan has ended", [
    "Your heyitsme Pro plan has ended.",
    "",
    `Renew by ${dateText(input.holdFrom)} to keep your cards online. After that, every card that still uses a Pro feature is paused: people who open its link, QR code or NFC tag see a paused page.`,
    "",
    "A card that uses no Pro feature stays online. You can also take the Pro features off a card to bring it back. Nothing is deleted.",
    "",
    `Renew or see what is affected: ${input.billingUrl}`,
  ]);
}

/** Sent once a few days before a Pro plan that is renewed by hand (GCash, QR Ph, card) ends. */
export function proRenewalDueMail(input: { to: string; endsAt: Date; holdFrom: Date; billingUrl: string }): MailMessage {
  return plain(input.to, "Your heyitsme Pro plan ends soon", [
    `Your heyitsme Pro plan ends on ${dateText(input.endsAt)}. It does not renew by itself.`,
    "",
    `To keep Pro, pay for the next month on your Billing page. If it is not renewed by ${dateText(input.holdFrom)}, every card that still uses a Pro feature is paused.`,
    "",
    "Nothing is deleted. Paying brings everything back as it was.",
    "",
    `Renew now: ${input.billingUrl}`,
  ]);
}

/** Sent once a few days before a team's plan that is renewed by hand ends. */
export function teamRenewalDueMail(input: { to: string; teamName: string; endsAt: Date; holdFrom: Date; teamUrl: string }): MailMessage {
  return plain(input.to, `${input.teamName}: your heyitsme Teams plan ends soon`, [
    `The plan for your team, ${input.teamName}, ends on ${dateText(input.endsAt)}. It does not renew by itself.`,
    "",
    `To keep the team running, pay for the next month on the team's Billing tab. If it is not renewed by ${dateText(input.holdFrom)}, the team is put on hold: its company cards, event pages and review pages are paused.`,
    "",
    "Nothing is deleted. Paying brings everything back as it was.",
    "",
    `Open your team: ${input.teamUrl}`,
  ]);
}

/** Sent after a verified payment for a team's plan. */
export function teamPaymentSucceededMail(input: { to: string; periodEnd: Date; teamUrl: string }): MailMessage {
  const lines = [
    "Your payment went through. heyitsme Teams is on for your team.",
    "",
    `The team's plan runs until ${dateText(input.periodEnd)}. Renew from the team's Billing tab before then. If it runs out and is not renewed within 3 days, the team is put on hold until it is paid. Nothing is deleted.`,
    "",
    `Open your team: ${input.teamUrl}`,
  ];
  return {
    to: input.to,
    subject: "Your heyitsme Teams plan is active",
    text: lines.join("\n"),
    html: lines.map((line) => (line ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "")).join(""),
  };
}

/** Sent after a verified payment. No amounts beyond the plan, no payment details. */
export function paymentSucceededMail(input: { to: string; periodEnd: Date; foundingNumber: number | null; billingUrl: string; renewsAutomatically: boolean }): MailMessage {
  const lines = [
    "Your payment went through. heyitsme Pro is on.",
    "",
    input.renewsAutomatically
      ? `Your plan renews by itself each month with Maya. The next payment is on ${dateText(input.periodEnd)}. To stop it, cancel from Billing before then.`
      : `Pro stays active until ${dateText(input.periodEnd)}. We will remind you before then.`,
  ];
  if (input.foundingNumber !== null) lines.push(`You are Founding Member #${input.foundingNumber}. Your founding price holds while your plan stays active.`);
  lines.push("", `See your plan and receipts: ${input.billingUrl}`);
  return {
    to: input.to,
    subject: "Your heyitsme Pro plan is active",
    text: lines.join("\n"),
    html: lines.map((line) => (line ? `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : "")).join(""),
  };
}
