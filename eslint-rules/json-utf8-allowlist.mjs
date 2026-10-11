/**
 * Legacy call sites of NextResponse.json without a charset (staffpass/json-utf8 off
 * here). Can only shrink (lib/lint/eslint-json-utf8.test.ts); the mechanical
 * replacement PR (#327 remainder b) empties it.
 */
export const JSON_UTF8_LEGACY_ALLOWLIST = [];
