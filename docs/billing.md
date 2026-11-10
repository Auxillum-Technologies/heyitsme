# Billing and Pro launch

Free is PHP 0 forever: one card, 10 contact exchanges per calendar month in Asia/Manila, seven-day analytics and heyitsme branding. Pro is PHP 299/month: five cards, unlimited exchanges, 365-day analytics, premium design, branded QR, QR campaigns, contact management and CSV export.

`shared/plans.ts` owns prices, limits and capability flags. New checkout accepts only `pro`, `monthly` and an enabled payment channel. The server charges 29900 PHP centavos. Browser amounts and extra checkout fields are rejected.

## Launch flags

Design, QR campaigns and advanced analytics default on for this release. Payments and plan limits default off until merchant checkout is verified. Explicit environment values override these defaults. The browser reads public flags through billing endpoints.

| Variable | Effect |
|---|---|
| `PAYMENTS_ENABLED` | Opens checkout on the gateway that `PAYMENT_PROVIDER` names. |
| `PAYMENT_PROVIDER` | `paymongo` or `2c2p` (default). Any other value refuses checkout. |
| `PLAN_LIMITS_ENABLED` | Enforces one/five-card limits, Free monthly quota and analytics retention access. |
| `PRO_DESIGN_ENABLED` | Enables Pro design and advanced QR writes. Paid entitlement is still required. |
| `QR_CAMPAIGNS_ENABLED` | Enables campaign creation and scan recording. Creation requires Pro and an owned card. |
| `PRO_ANALYTICS_ENABLED` | Enables additional charts and campaign analytics for Pro. |
| `GOOGLE_PAY_ENABLED`, `GCASH_ENABLED` | Enables the corresponding hosted checkout channel. Google Pay runs on 2C2P only. |
| `CARD_ENABLED`, `MAYA_ENABLED`, `QRPH_ENABLED` | Enables card, Maya and QR Ph. PayMongo only. |
| `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` | Server-only PayMongo credentials. The webhook secret is shown once, when the webhook is made in the PayMongo dashboard. |
| `PAYMONGO_SUBSCRIPTIONS_ENABLED` | Lets Maya renew by itself each month. Turn it on only after PayMongo support enables Subscriptions on the account. Default off. |
| `TEAMS_BILLING_ENABLED` | Sells Teams at checkout. Needs `TEAMS_ENABLED`, `PAYMENTS_ENABLED` and a payment channel. Default off. |
| `CRON_SECRET` | Shared with Vercel Cron for the daily plan run. Empty: the run is refused, so no notices are sent and free teams keep no end date. |
| `PAYMENT_PROVIDER_ENV` | Defaults to sandbox (PayMongo test mode). Set production only after sandbox verification. |
| `PAYMENT_GATEWAY_MERCHANT_ID`, `PAYMENT_GATEWAY_SECRET` | Server-only 2C2P credentials. |
| `COMPLIMENTARY_EMAILS` | Preserves the existing owner/admin complimentary entitlement. |

Each checkout sells one monthly access period. On 2C2P, and on PayMongo for GCash, QR Ph and card, renewal is manual through Billing. On PayMongo, Maya can renew by itself (see PayMongo). Subscription cancellation keeps access through the paid period. Historical payment records still settle against their stored amount and billing term.

## PayMongo

Owner decision, 2026-11-09: PayMongo is the gateway, with `PAYMENT_PROVIDER=paymongo`.
The adapter is `server/billing/paymongo.ts`.
The 2C2P adapter stays, and `PAYMENT_PROVIDER=2c2p` selects it.

**Channels.**
GCash, QR Ph and card pay one prepaid month on the PayMongo hosted Checkout page.
No card number is typed on heyitsme, so the CSP does not change.
Maya renews by itself each month through a PayMongo subscription while `PAYMONGO_SUBSCRIPTIONS_ENABLED` is on.
While it is off, Maya also pays one prepaid month.
No gateway can charge GCash on its own today, so GCash buyers renew by hand.
The pay button for a channel that renews by itself says "renews each month" (`billing.offer.autoRenewChannels`).

**Settlement.**
PayMongo calls `POST /api/payments/paymongo/webhook`.
The route reads the raw body and checks the `Paymongo-Signature` header (HMAC-SHA256 of `t.body`, `te` in test mode, `li` in live mode, at most 5 minutes old).
It is registered before the JSON parser, because a parsed body breaks the signature.
A verified event is only a hint.
The server reads the Checkout Session or the subscription back from PayMongo, then calls `settlePayment` as for every other payment.
`payments.providerCheckoutRef` keeps the session or subscription id that checkout opened.
Each paid renewal invoice adds one `payments` row with purpose `renewal` (`teams` for a team), copied from the first payment, and moves the plan end one month.
The invoice id is stored in the unique `payments.providerInvoiceRef`, so a repeated delivery changes nothing.
Unknown event types get a 200, so PayMongo does not retry them.

**Status.**
PayMongo `past_due` sets `past_due`, and Pro stays for the 3-day grace after the plan end.
`unpaid` (after PayMongo's last retry) sets `expired`.
A cancel made at PayMongo sets `canceled` with access to the end of the paid month.
A later paid invoice makes the plan active again.
A team has no status: its plan date decides, as before.
When PayMongo reports a team's subscription `unpaid` or cancelled, the team renews by hand again, so its owner can pay another way.

**Cancel and resume.**
Cancel stops the PayMongo subscription first.
If PayMongo cannot stop it, nothing changes and the buyer sees an error.
PayMongo cannot restart a cancelled subscription, so resume keeps the plan and makes it renewed by hand.
A canceled plan that is then paid by hand (Renew early) also renews by hand, because its PayMongo subscription is already stopped.
A team owner can stop a team's auto-renewal on the team's Billing tab, with the same rule: PayMongo first, then the team keeps its plan date and renews by hand.
A plan that renews by itself refuses a second checkout, and Billing hides Renew early for it.
While a plan still has paid time, Renew early offers only one-time methods, and the server refuses Maya auto-renewal, because PayMongo charges from the day a subscription starts.
The PayMongo subscription of a person's plan is on `subscriptions.providerSubscriptionRef`, and of a team on `workspaces.providerSubscriptionRef` (`drizzle/0023_paymongo.sql`).

**Reminders.**
The daily run sends one email 3 days before a plan that is renewed by hand ends: Pro to the buyer, Teams to the team owner.
A plan that renews by itself, a canceled plan and a team that was never paid get none.

**Refunds.**
`PayMongoProvider.refundPayment` refunds all or part of a payment by its PayMongo payment id (`pay_...`).
There is no screen for it yet.
A renewal is stored by its invoice id, so refund it in the PayMongo dashboard.

**Setup, in this order.**
1. In the PayMongo dashboard (test mode), make a webhook for `https://<host>/api/payments/paymongo/webhook` with the events `checkout_session.payment.paid` and every `subscription.*` event.
2. Set `PAYMENT_PROVIDER=paymongo`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` and the channel flags. Keep `PAYMONGO_SUBSCRIPTIONS_ENABLED` off until PayMongo support enables Subscriptions.
3. Run one test payment per channel, a repeated webhook delivery, and, once Subscriptions is on, one test renewal cycle (PayMongo "Create a new test Subscription cycle").
4. Then follow the order in Verification and migration.

## Holds

Owner decision, 2026-10-06. A hold pauses what a plan paid for once the plan has ended and `HOLD_GRACE_DAYS` (3) have passed. Nothing is deleted, and paying lifts the hold at once. Holds are worked out from the dates on every request (`server/billing/hold.ts`, `teamHeld` in `server/teams/entitlements.ts`). There is no stored flag to get out of step.

**Personal cards.** A card is on hold when its owner had a paid plan (a subscription that was paid, or a plan override that expired), the plan ended 3 or more days ago, the account is on Free now, and the card still uses a Pro feature: a custom accent color, a Pro design, a Pro QR style or hidden branding. While `PLAN_LIMITS_ENABLED` is on, more than 2 photos and every card after the owner's oldest also count. An owner who never paid is never put on hold. Complimentary accounts are never put on hold. QR campaigns and Google review pages alone do not put a card on hold.

On hold, `publicCard.bySlug`, `review` and `exchange` answer `FORBIDDEN` with `PAUSED_MESSAGE`, the contact file and QR image answer 404, the card page is served without the card's name or photo, and no view is counted. The visitor sees a paused page. The owner sees, on every workspace page, which cards are paused and what each one uses (`billing.me.cardHolds`), with a Renew Pro button. Taking the Pro features off a card brings it back without paying.

**Teams.** Teams has no free tier once `TEAMS_BILLING_ENABLED` is on. A team never paid for is on hold from the start. A team whose plan ran out is read-only for 3 days, then on hold. On hold: its company cards, event pages, RSVP forms and review pages are paused, and every Team call answers `FORBIDDEN` with `TEAM_HOLD_MESSAGE`, downloads included. Only the calls marked `whileHeld` still work: `teams.get`, `teams.billing`, closing, removing a person, leaving. Paying (`billing.createTeamCheckout`) is outside the Team procedures and is never blocked. Members see a hold screen with a Leave button. The owner sees the same screen with the Pay buttons.

**The daily run.** `GET /api/cron/plans` runs once a day from Vercel Cron (`vercel.json`), guarded by `CRON_SECRET`. Without the secret set it refuses every call. It does three things, each at most once:

1. While Teams is sold, a team with no end date gets one `FREE_TEAM_NOTICE_DAYS` (14) away, and its owner is emailed. Its hold then starts 3 days after that date.
2. A team whose plan ended in the last 3 days: one email to its owner with the hold date.
3. An account whose paid Pro ended in the last 3 days: one email with the hold date. A plan override that expires sends no email.

Sent notices are remembered as `appSettings` rows named `notice:<kind>:<id>:<end time>`.

Staff note: `teams.adminSetPlan` with an empty date no longer means free forever while Teams is sold. The next daily run gives that team a date 14 days away. To give a team free time, set a far date.

## Teams plan

Teams is bought for a team, not for an account. `TEAMS_PLAN` in `shared/plans.ts` holds the price and the seats: PHP 1,499 a month for each team, 10 seats included. Change the price there and nowhere else. More seats are set by heyitsme staff for a team. They are not sold at checkout.

While `TEAMS_BILLING_ENABLED` is off, starting a team is free and the team has no end date. Turning it on makes Teams paid for every team. Teams that already exist get 14 days of notice from the daily run (see Holds). For a team started after that:

1. `teams.create` makes the team unpaid: its plan date is the moment it was made, so it is on hold until it is paid (see Holds).
2. The owner pays from the Billing page or the team's Billing tab. `billing.createTeamCheckout` takes a team id and a channel, checks ownership, and charges the server's price. The payment row has `purpose` and `planCode` `teams`, and names the team in `metadataJson`.
3. Settlement follows the same rules as Pro: signed callback, direct inquiry, amount and currency compared to the stored row, settled once. It moves the team's plan date on one month, from its current end if still running, from today if not. Seats are raised to the included number, never lowered. The team's activity log records `plan.paid`.

A team with no end date is free for good. Checkout refuses it, and settlement never gives it an end date. Renewal is manual. A lapsed team is read-only and nothing is deleted. A Teams payment does not change the owner's personal plan. No schema change was needed.

## Verification and migration

1. Apply billing migration `drizzle/0009_billing.sql` and Pro tools migration `drizzle/0010_pro_tools.sql` in staging. Runtime schema setup is idempotent. Apply RLS as the table owner and verify `qrCampaigns` has RLS enabled without public policies.
2. Enable design/campaign/analytics flags on staging and grant a test Pro entitlement.
3. Verify Free cannot save premium designs, create card two, export CSV, edit CRM metadata or read long analytics ranges. Existing cards above plan limits stay live and editable.
4. Confirm Google Pay / GCash availability for PHP with the merchant. Verify one sandbox checkout and signed callback, failed payment, duplicate callback and amount mismatch. On PayMongo, follow the setup steps in PayMongo.
5. Enable payment channels in production only after merchant verification. Enable plan limits after checkout succeeds.

The callback is a hint, never proof of payment. The server checks the callback signature and merchant, queries 2C2P directly, compares amount/currency to the stored invoice and settles idempotently. Browser returns never grant Pro.

Visual configuration lives in existing `cards.page` JSON. Server validation checks allowed fonts/animations/colors, contrast, QR contrast and entitlement changes. Existing premium settings can be retained on an unchanged card after downgrade. New premium changes require Pro. Campaign scans store campaign/card/time without visitor identifiers.

CSV export queries only the authenticated owner's contacts and escapes spreadsheet formulas. Contact statuses are New, Contacted, Follow-up, Converted and Archived. Public QR links retain `/c/:slug` with a `campaign` query parameter.

Run `pnpm check`, `pnpm test` and `pnpm build` before release. Unit/integration verification uses PGlite and a fake gateway. A live merchant payment remains a separate launch requirement.
