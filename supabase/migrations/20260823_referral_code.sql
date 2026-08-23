-- Thin referral tracking (Kimura stage 2).
-- Optional partner code on org (format AIC-XXXX). No Connect / portal.

alter table orgs
  add column if not exists referral_code text;

comment on column orgs.referral_code is
  'Optional partner referral code (AIC-XXXX). Kickoff+monthly payout only; manual monthly; no Stripe Connect.';
