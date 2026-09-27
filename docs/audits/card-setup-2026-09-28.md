# Security Audit Report: External Contract Card Setup (EXTERNAL_CONTRACT_CARD_SETUP)

**Date:** 2026-09-28  
**Auditor:** Cloud Agent  
**Scope:** PRs #119, #120 (design, data model), #121 (migration, implementation)  
**Flag:** `EXTERNAL_CONTRACT_CARD_SETUP` (currently OFF)

---

## Executive Summary

Full security audit of the external contract card registration feature before production enablement. This audit covers PAN/CVC handling, Stripe integration security, deep-link token security, approval class routing, webhook handling, cross-org isolation, RLS policies, and secret detector coverage.

### Findings Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 1 | **FIXED** |
| High | 1 | **FIXED** |
| Medium | 0 | - |
| Low | 2 | Acknowledged |
| Info | 3 | - |

### Verdict: **GO** (after fixes applied)

The implementation is safe for production enablement after the Critical and High severity issues are fixed. All core security constraints are properly implemented.

---

## Findings Table

| # | Severity | Component | Issue | Resolution |
|---|----------|-----------|-------|------------|
| 1 | **Critical** | `app/api/webhooks/stripe/route.ts` | Stripe webhook route does NOT integrate `processCardSetupWebhook`. Card setup events (`setup_intent.succeeded`, `setup_intent.canceled`, `checkout.session.expired`) are not processed. | **FIXED**: Integrated `processCardSetupWebhook` into webhook route with proper event routing. |
| 2 | **High** | `lib/admin-mcp/fulfill-admin.ts` | No fulfillment handlers for `cardSetup.mintLink` and `cardSetup.mintPortalLink`. After always_human approval is granted, the card setup session is never created. | **FIXED**: Added fulfillment handlers that call `createCardSetupSession` and `createPortalLink` after approval. |
| 3 | **Low** | `lib/external-contract-card/queue-card-setup.ts:22` | Uses custom `auditClass: "external_contract_card_setup"` instead of standard `ADMIN_AUDIT_CLASS`. However, the `purpose: "admin.card_setup_link_mint"` correctly routes to admin class via `purpose.startsWith("admin.")`. | **Acknowledged**: Classification works correctly via purpose prefix. |
| 4 | **Low** | Stripe Webhook | Webhook secret validation depends on `STRIPE_WEBHOOK_SECRET` env variable. If misconfigured with `replace_me` prefix, webhooks are silently ignored. | **Acknowledged**: This is intentional fail-open for demo mode. Production requires proper secret. |
| 5 | **Info** | Deep-link token | Token entropy handled by Stripe Checkout session URL. 15-minute expiry enforced. Single-use enforced by Stripe. Org binding via metadata. | ✓ PASS |
| 6 | **Info** | Cross-org isolation | RLS enabled on both tables. Data layer queries include `org_id` filter. Webhook handler validates `orgId` from metadata. | ✓ PASS |
| 7 | **Info** | Secret detector | Card patterns (Visa, MC, Amex, Discover, JCB, generic) with Luhn validation. `[CARD_DATA_REDACTED]` redaction never exposes digits. False positive avoidance for phone numbers, UUIDs, Stripe IDs. | ✓ PASS |

---

## Detailed Findings

### Finding #1 (Critical): Webhook Handler Not Integrated

**Location:** `app/api/webhooks/stripe/route.ts`

**Issue:** The Stripe webhook route handles subscription events (`customer.subscription.*`, `invoice.*`, `checkout.session.completed`) but does NOT call `processCardSetupWebhook` for card setup events. The `processCardSetupWebhook` function exists in `lib/external-contract-card/webhook-handler.ts` but is never invoked.

**Impact:** Card setup completion events are silently ignored:
- `setup_intent.succeeded` - payment method not persisted
- `setup_intent.canceled` - failure not recorded
- `checkout.session.expired` - expiry not recorded

**Fix:** Integrated `processCardSetupWebhook` call at the start of webhook handling, before subscription event processing.

### Finding #2 (High): Missing Fulfillment Handlers

**Location:** `lib/admin-mcp/fulfill-admin.ts`

**Issue:** The `fulfillApprovedAdminCore` switch statement does not include cases for:
- `cardSetup.mintLink`
- `cardSetup.mintPortalLink`

When an always_human approval is granted, the approval ticket resolves but no fulfillment action occurs.

**Impact:** Users approve card setup requests but receive no Stripe Checkout link.

**Fix:** Added fulfillment handlers that:
1. Call `createCardSetupSession` / `createPortalLink` after approval
2. Persist fulfillment metadata with the link URL
3. Record audit events

---

## Security Constraint Verification

### L1: Raw Card Forbidden (PAN/CVV/expiry)

| Check | Result |
|-------|--------|
| DB schema has no PAN columns | ✓ PASS - Only `stripe_payment_method_id` (token) stored |
| Webhook handler ignores card details | ✓ PASS - Only extracts `payment_method` ID |
| Logs contain no card data | ✓ PASS - Logs only `orgId`, `setupIntentId`, `customerId` |
| Chat/MCP never receives card data | ✓ PASS - Only deep links and status |
| Secret detector blocks card-like strings | ✓ PASS - With Luhn validation |

### L3: Stripe-Hosted Only

| Check | Result |
|-------|--------|
| Checkout mode=setup | ✓ PASS - `stripe.checkout.sessions.create({ mode: "setup" })` |
| Customer Portal for change/delete | ✓ PASS - `stripe.billingPortal.sessions.create()` |
| No in-chat card forms | ✓ PASS - Only links + nextStepJa |

### L9: always_human Approval

| Check | Result |
|-------|--------|
| Card setup queue sets `always_human: true` | ✓ PASS |
| Portal link queue sets `always_human: true` | ✓ PASS |
| Approval class routes to admin approvers | ✓ PASS - Via `purpose.startsWith("admin.")` |

### Webhook Security

| Check | Result |
|-------|--------|
| Signature verification with `STRIPE_WEBHOOK_SECRET` | ✓ PASS - `stripe.webhooks.constructEvent()` |
| Fail-closed on invalid signature | ✓ PASS - Returns 400 error |
| Idempotency check | ✓ PASS - `isSetupIntentProcessed()` before persisting |
| Replay protection | ✓ PASS - Idempotency + Stripe event ID |

### Deep-Link Token Security

| Check | Result |
|-------|--------|
| Entropy | ✓ PASS - Stripe-generated session URL |
| Expiry | ✓ PASS - 15 minutes (`expires_at` set on session) |
| Single-use | ✓ PASS - Stripe Checkout sessions are single-use |
| Org binding | ✓ PASS - `orgId` in session metadata, validated on webhook |

### RLS on New Tables

| Table | RLS Status |
|-------|------------|
| `org_external_contract_payment_methods` | ✓ Enabled - `is_org_member(org_id)` / `is_org_admin(org_id)` |
| `audit_external_contract_card_events` | ✓ Enabled - `is_org_member(org_id)` |

### Cross-Org Isolation

| Check | Result |
|-------|--------|
| Data queries include `org_id` filter | ✓ PASS |
| Webhook validates `orgId` from metadata | ✓ PASS |
| Payment method completion requires `org_id` + `setup_intent_id` match | ✓ PASS |

### Flag-OFF Parity

| Check | Result |
|-------|--------|
| All endpoints check `isExternalContractCardSetupEnabled()` | ✓ PASS |
| Returns `feature_disabled` error when OFF | ✓ PASS |
| Webhook ignores card events when flag OFF | ✓ PASS |

---

## Required Environment Variables

| Variable | Purpose | Required for Prod |
|----------|---------|-------------------|
| `STRIPE_SECRET_KEY` | Stripe API calls | **Yes** |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification | **Yes** |
| `EXTERNAL_CONTRACT_CARD_SETUP` | Feature flag (set to `1` to enable) | **Yes** (set to `1`) |
| `NEXT_PUBLIC_APP_URL` | Return URL for Checkout/Portal | **Yes** |
| `BILLING_NOTIFY_EMAIL` | Notification recipient | Recommended |

### Stripe Live vs Test Mode

The `STRIPE_SECRET_KEY` format determines mode:
- `sk_test_*` = Test mode (safe for staging)
- `sk_live_*` = Live mode (production)

**Recommendation:** Use test mode (`sk_test_*`) until full production GO.

---

## Production Enable Steps

### 1. Environment Configuration

```bash
# Required
STRIPE_SECRET_KEY=sk_live_xxxx           # Live mode key
STRIPE_WEBHOOK_SECRET=whsec_xxxx         # From Stripe Dashboard
EXTERNAL_CONTRACT_CARD_SETUP=1           # Enable feature
NEXT_PUBLIC_APP_URL=https://staffpass.sealith.com  # Production URL

# Recommended
BILLING_NOTIFY_EMAIL=billing@yourcompany.com
```

### 2. Stripe Dashboard Webhook Configuration

**Endpoint URL:** `https://staffpass.sealith.com/api/webhooks/stripe`

**Required Events:**
- `setup_intent.succeeded`
- `setup_intent.canceled`
- `checkout.session.expired`
- `checkout.session.completed` (already configured for subscription flow)

**Steps:**
1. Go to Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://staffpass.sealith.com/api/webhooks/stripe`
3. Select events listed above
4. Copy the Signing Secret to `STRIPE_WEBHOOK_SECRET`
5. Enable the endpoint

### 3. Verify Configuration

1. Confirm `EXTERNAL_CONTRACT_CARD_SETUP=1` in production env
2. Verify webhook endpoint is receiving test events
3. Run a test card setup flow in Stripe test mode first
4. Monitor `audit_external_contract_card_events` table for correct logging

### 4. Production Enable Checklist

- [ ] `STRIPE_SECRET_KEY` is `sk_live_*` format
- [ ] `STRIPE_WEBHOOK_SECRET` is configured from Dashboard
- [ ] Webhook endpoint URL added to Stripe Dashboard
- [ ] Required events subscribed in Dashboard
- [ ] `EXTERNAL_CONTRACT_CARD_SETUP=1` in production env
- [ ] Test flow completed in staging
- [ ] Audit log verification passed

---

## Test Coverage

| Test | Coverage |
|------|----------|
| Feature flag default OFF | ✓ Covered |
| Feature flag enable/disable | ✓ Covered |
| Card-like string detection | ✓ Covered (Visa, MC, Amex, Discover, JCB) |
| Luhn checksum validation | ✓ Covered |
| False positive avoidance | ✓ Covered (phone, UUID, Stripe IDs) |
| Detector redaction | ✓ Covered (`[CARD_DATA_REDACTED]`) |
| Session metadata separation | ✓ Covered |
| PAN column prohibition | ✓ Covered |
| Webhook signature verification | ✓ Covered (NEW) |
| Webhook idempotency | ✓ Covered (NEW) |
| Fulfillment handler | ✓ Covered (NEW) |

---

## Conclusion

### GO/NO-GO Decision: **GO** (Conditional)

The external contract card setup implementation is **SAFE FOR PRODUCTION** after the following conditions are met:

1. ✅ Critical fix applied: Webhook handler integration
2. ✅ High fix applied: Fulfillment handlers added
3. ⬜ Stripe Dashboard webhook configuration complete
4. ⬜ Environment variables set correctly
5. ⬜ Test flow verification in staging

### Security Posture

- **PAN/CVC handling:** ✓ Card data never touches Staffpass servers
- **Stripe-hosted:** ✓ All card entry on Stripe pages
- **Approval flow:** ✓ always_human correctly enforced
- **Webhook security:** ✓ Signature verification + idempotency
- **Cross-org isolation:** ✓ RLS + data layer filters
- **Secret detection:** ✓ Card patterns blocked with Luhn validation

---

*Report generated: 2026-09-28*
