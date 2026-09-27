# Google Calendar Free/Busy Read Integration

## Summary

This integration allows AI employees to read busy intervals from calendars shared with their Google account, for use in `calendar.propose` scheduling. Read-only access only — no write scope ever requested.

**Feature Flag**: `GOOGLE_CALENDAR_READ_ENABLED` (default OFF)

**Scopes**: `openid email https://www.googleapis.com/auth/calendar.freebusy`

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  AI Employee    │    │   Staffpass     │    │ Google Calendar │
│  (Grok Bot)     │───▶│  Gateway        │───▶│   API           │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │ calendar_read   │
                       │ _grants table   │
                       │ (allowlist)     │
                       └─────────────────┘
```

### Data Flow

1. Employee connects Google account via OAuth (start → callback)
2. Admin adds calendar IDs to allowlist via `calendar.allowlist.patch` (requires approval)
3. `calendar.read` queries freebusy only for calendar IDs ∩ allowlist
4. `calendar.propose` uses busy data to filter candidate slots

## Ops Prerequisites

### Google Cloud Console Setup

1. Create OAuth 2.0 Client ID (Web application type)
2. Add authorized redirect URI: `https://{your-domain}/api/google/oauth/callback`
3. Configure OAuth consent screen:
   - App name, logo, support email
   - Scopes: `openid`, `email`, `calendar.freebusy`
   - **Important**: `calendar.freebusy` is a sensitive scope — unverified apps are limited to 100 test users
4. For production: submit app for Google verification

### Environment Variables

```bash
# Required
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret

# Required for production (recommended)
# Dedicated HMAC key for OAuth state signing. If unset, falls back to GOOGLE_OAUTH_CLIENT_SECRET.
GOOGLE_OAUTH_STATE_SECRET=your-32-char-min-random-secret

# Optional (defaults to standard callback path)
GOOGLE_OAUTH_REDIRECT_URL=https://your-domain/api/google/oauth/callback

# Encryption key for refresh tokens (shared with notification config)
NOTIFICATION_CONFIG_ENCRYPTION_KEY=your-encryption-key

# Feature flag (keep OFF until security audit complete)
GOOGLE_CALENDAR_READ_ENABLED=false
```

### Database Migration

Apply **before** enabling feature flag:

```sql
-- File: supabase/migrations/20260927500000_google_calendar_freebusy.sql
-- Apply via: supabase db push
```

Tables created:
- `employee_google_identities` — public binding (no secrets)
- `employee_google_identity_secrets` — encrypted refresh tokens (service_role only)
- `calendar_read_grants` — allowlist for queryable calendar IDs

## Security Considerations

### Scope Validation

Callback validates that granted scopes:
1. Include `calendar.freebusy` (required)
2. Do NOT include forbidden scopes (`calendar`, `calendar.events`, etc.)
3. Do NOT include unknown scopes (fail-closed)

### OAuth Security

- **PKCE**: Code verifier stored in secure httpOnly cookie (never in state parameter)
- **State signing**: HMAC-signed with `GOOGLE_OAUTH_STATE_SECRET` (or `GOOGLE_OAUTH_CLIENT_SECRET` fallback)
- **ID token validation**:
  - Audience matches our client ID
  - Issuer is `https://accounts.google.com` or `accounts.google.com`
  - Token not expired
  - Email is verified

### Token Handling

- Refresh tokens encrypted with `NOTIFICATION_CONFIG_ENCRYPTION_KEY`
- Tokens never appear in:
  - API responses
  - Audit metadata
  - Logs
  - Chat/LLM context
- RLS: `employee_google_identity_secrets` accessible only via service_role (browser cannot write)

### Allowlist Enforcement

- `calendar.read` only queries calendar IDs present in `calendar_read_grants`
- Requested but unlisted IDs are refused (not queried)
- Adding/removing grants requires human approval (`calendar.allowlist.patch` is `forceNeedsApproval`)

### Audit Trail

Every freebusy read logs:
- Employee ID, job ID
- Requested calendar IDs
- Allowed vs refused calendar IDs
- Time window
- Busy interval counts
- Per-calendar errors

Never logged: tokens, event contents (freebusy has none anyway)

## Rollout Checklist

### Before Enabling in Production

- [ ] Full security audit complete
- [ ] Google Cloud OAuth client created
- [ ] OAuth consent screen configured
- [ ] For >100 users: Google app verification submitted/approved
- [ ] Environment variables set:
  - [ ] `GOOGLE_OAUTH_CLIENT_ID`
  - [ ] `GOOGLE_OAUTH_CLIENT_SECRET`
  - [ ] `GOOGLE_OAUTH_STATE_SECRET` (recommended: dedicated signing key)
  - [ ] `NOTIFICATION_CONFIG_ENCRYPTION_KEY`
- [ ] Database migration `20260927500000_google_calendar_freebusy.sql` applied
- [ ] Test users validated in staging

### Enabling

```bash
GOOGLE_CALENDAR_READ_ENABLED=true
```

### Post-Enable Monitoring

- Monitor audit events for `calendar.freebusy_read`
- Watch for `needs_reauth` status (token refresh failures)
- Check for scope validation failures in callback

## API Reference

### OAuth Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/google/oauth/start?employeeId=...` | GET | Initiates OAuth flow |
| `/api/google/oauth/callback` | GET | OAuth callback (handles code exchange) |
| `/api/google/oauth/disconnect` | POST | Revokes and removes Google identity |

### Gateway Tools

| Tool | Kind | Approval |
|------|------|----------|
| `calendar.read` | read | mayAuto |
| `calendar.propose` | propose | mayAuto |
| `calendar.confirm` | confirm | forceNeedsApproval |
| `calendar.allowlist.patch` | mutate | forceNeedsApproval |

### calendar.read Request

```typescript
{
  calendarIds: string[];  // Must be in allowlist
  timeMin: string;        // ISO8601
  timeMax: string;        // ISO8601 (max 31 days from timeMin)
}
```

### calendar.read Response

```typescript
{
  ok: boolean;
  busyByCalendar: Record<string, BusyInterval[]>;
  errors: Record<string, { code: string; message: string }>;
  refused: string[];      // Calendar IDs not in allowlist
  queried: string[];      // Calendar IDs actually queried
}
```

## Limitations

- Max query window: 31 days
- Max calendars per request: 50
- Unverified apps: limited to 100 test users
- Read-only: no event creation, modification, or deletion
- Busy intervals only: no event details (freebusy API limitation)
