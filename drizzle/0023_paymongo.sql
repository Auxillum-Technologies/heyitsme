-- PayMongo: the Checkout Session or subscription a payment opened, so the server can read it back by its id,
-- and the PayMongo subscription that renews a team's plan (a person's plan keeps it on "subscriptions").
-- Every column is empty for existing rows. Nothing is deleted.
alter table "payments" add column if not exists "providerCheckoutRef" varchar(128);
create index if not exists "payments_provider_checkout_idx" on "payments" ("providerCheckoutRef");
create index if not exists "subscriptions_provider_subscription_idx" on "subscriptions" ("providerSubscriptionRef");
alter table "workspaces" add column if not exists "providerSubscriptionRef" varchar(128);
create unique index if not exists "workspaces_provider_subscription_idx" on "workspaces" ("providerSubscriptionRef");
