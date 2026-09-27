# Security Audit Report: Approval Routing P0 (Items 1-7)

**Date:** 2026-09-27  
**Auditor:** Cloud Agent  
**Scope:** PRs #122, #123, #124, #125, #126, #127, #128 (merged to main)  
**Mode:** READ-ONLY audit (no code changes except optional failing tests)  
**Update:** PR #129 - Reviewer corrections and fixes applied

---

## Executive Summary

This audit covers the approval routing P0 implementation across 6 phases. The implementation demonstrates strong security fundamentals with proper tenant isolation, metadata-driven classification, and fail-closed semantics. Several findings require attention before enabling enforcement in production.

### Findings Summary (Updated)

| Severity | Count | After Fix |
|----------|-------|-----------|
| Critical | ~~1~~ | 0 |
| High | ~~2~~ | 0 |
| Medium | ~~4~~ | 0 |
| Low | 3 | 3 |
| Info | 2 | 2 |

**Recommendation:** ~~Fix Critical and High severity issues before enabling `admin_approver_enforcement=true` in production.~~ All Critical and High issues resolved in PR #129.

---

## Findings Table (Updated with Resolution)

| # | Severity | File:Line | Issue | Resolution |
|---|----------|-----------|-------|------------|
| 1 | ~~Critical~~ **Low** | `lib/slack/interactivity-channel-resolver.ts:70-85` | Multi-app signing secret iteration | **Reclassified to Low.** Reviewer verified: approval lookup already scoped by `channel.orgId` BEFORE `resolveApproval` (lines 222, 229). Added defense-in-depth: if >1 candidate's secret verifies, fail closed with "ambiguous_secret" and log. Test added. |
| 2 | ~~High~~ **Fixed** | `lib/approval-workflow/voter-binding.ts:330` | No rate limit on verification codes | **Fixed.** Added `failed_verification_attempts` counter. After 5 failures, binding is locked. Migration `20260927400000_voter_binding_security_hardening.sql` adds column. Note: code only arrives in HMAC-signed button value, so brute-force is already mitigated; counter is defense-in-depth. |
| 3 | **Known Gap** | (Known gap) | Delivery unique constraint | Per brief - acknowledged limitation. N/A |
| 4 | ~~Medium~~ **Fixed** | `lib/approval-workflow/voter-binding.ts:343-363` | Race condition in concurrent verification (non-atomic SELECT+UPDATE) | **Fixed.** UPDATE now includes conditional WHERE: `verified_at IS NULL AND verification_hash = expected AND revoked_at IS NULL AND verification_expiry > now()`. Zero rows = failure with "verification_race_or_expired". |
| 5 | ~~Medium~~ **Verified** | `20260927100000_voter_binding_verification.sql` | New columns lack explicit RLS | **Verified.** RLS enabled on `approval_workflow_voter_bindings` with restrictive policy `workflow_server_only` that blocks all access from anon/authenticated. Column-level grants revoked. Migration `20260927400000` re-verifies RLS and revokes grants for new columns. |
| 6 | ~~Medium~~ **Fixed** | Multiple | Verification code single-use | **Fixed.** Reviewer verified: `verifyVoterBinding` already returns "already_verified" and clears `verification_hash`. Atomic UPDATE now ensures single-use at DB level. |
| 7 | **Info** | (Design) | Verification code org+user+team binding | ✓ PASS - Callback value is HMAC-signed with `timingSafeEqual` validation. |
| 8 | **Low** | `app/api/webhooks/telegram/route.ts` | Telegram global fallback | Mitigated by `TELEGRAM_ALLOWED_USER_IDS` |
| 9 | ~~Low~~ **Fixed** | Multiple | Timing attack on signature verification | **Fixed.** Hash comparison in `voter-binding.ts` now uses `timingSafeEqual`. |
| 10 | **Low** | Multiple | SSRF potential | No user-controlled fetch URLs found |
| 11 | **Info** | `lib/admin-mcp/self-approval.ts` | Self-approval check | ✓ Correctly implemented |
| 12 | **Info** | `lib/feature-flags.ts` | Flag defaults | ✓ All default OFF, legacy-safe |

---

## Additional Reviewer Findings (PR #129)

### Finding A: VOTER_BINDING_SECRET fallback to "dev-secret"

| Field | Value |
|-------|-------|
| **File:Line** | `lib/approval-workflow/voter-binding.ts:212,331`, `lib/approval-workflow/voter-binding-verification.ts:164` |
| **Issue** | `process.env.VOTER_BINDING_SECRET \|\| "dev-secret"` allows production to run with known weak secret |
| **Resolution** | **Fixed.** Added `getVoterBindingSecret()` / `getCallbackSecret()` helper that fails closed in production: throws if secret is missing, empty, or "dev-secret". Demo mode still allows fallback for local development. |

### Finding B: Hash comparison uses !==

| Field | Value |
|-------|-------|
| **File:Line** | `lib/approval-workflow/voter-binding.ts:333` |
| **Issue** | Non-constant-time string comparison vulnerable to timing attacks |
| **Resolution** | **Fixed.** Changed to `timingSafeEqual(expectedBuf, actualBuf)` with length check. |

### Finding C: team_id check skipped when missing

| Field | Value |
|-------|-------|
| **File:Line** | `lib/approval-workflow/voter-binding.ts:337-340` |
| **Issue** | When binding has `team_id` but input lacks `teamId`, check was skipped |
| **Resolution** | **Fixed.** When binding has `team_id`, `input.teamId` is now required. Missing = reject with "team_id_required". |

### Finding D: RLS on approval_workflow_voter_bindings

| Field | Value |
|-------|-------|
| **Issue** | Verify anon/authenticated cannot read `verification_hash` |
| **Resolution** | **Verified.** RLS enabled with restrictive policy `workflow_server_only` (from `20260916120000_f8_enforcement.sql`). All column grants revoked from public/anon/authenticated. Migration `20260927400000` re-verifies this and revokes grants for new columns. |

---

## Migration Summary

| Migration | Purpose |
|-----------|---------|
| `20260927400000_voter_binding_security_hardening.sql` | Adds `failed_verification_attempts` column for brute-force protection. Verifies RLS and revokes column grants. Idempotent. |

---

## Test Coverage

| Test File | Coverage |
|-----------|----------|
| `lib/approval-workflow/voter-binding.test.ts` | Added: brute-force lockout (5 attempts), team_id enforcement |
| `app/api/webhooks/slack/interactivity/route.test.ts` | Added: ambiguous secret detection |

---

## Verification Checklist (Updated)

- [x] Finding #1 addressed (reclassified to Low, defense-in-depth added)
- [x] Finding #2 addressed (brute-force counter added)
- [x] Finding #4 addressed (atomic UPDATE)
- [x] Finding #5 verified (RLS covers new columns)
- [x] Finding A addressed (fail-closed secret)
- [x] Finding B addressed (timingSafeEqual)
- [x] Finding C addressed (team_id required)
- [x] Finding D verified (RLS confirmed)
- [ ] Run full test suite with enforcement ON
- [ ] Verify at least one org owner exists before enabling per-org
- [ ] Verify Slack channels have `expectedTeamId` configured
- [ ] Test Slack Connect user rejection
- [ ] Test cross-org voter isolation (Org B voter cannot vote on Org A ticket)

---

## Conclusion

### Is Enforcement ON Safe After Fixes?

**YES** - All Critical and High severity issues have been resolved. The implementation is safe to enable `admin_approver_enforcement=true` after:

1. Running full test suite
2. Verifying org owner exists for each org
3. Configuring `expectedTeamId` for Slack channels

### Constraints Verified

- ✓ All enforcement flags stay default OFF
- ✓ No change to legacy approval behavior with flags OFF
- ✓ EXTERNAL_CONTRACT_CARD_SETUP untouched

---

*Report updated: 2026-09-27*
