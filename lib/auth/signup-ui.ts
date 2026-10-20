/**
 * Client-safe signup form constants.
 * signup-guard.ts pulls demo-data → bindings → node:crypto; keep that off the browser bundle.
 */
import { ORG_NAME_MAX_LENGTH } from "@/lib/text/org-name";

export const SIGNUP_TURNSTILE_ACTION = "signup";
export const SIGNUP_HONEYPOT_FIELD = "company_website";
export const SIGNUP_ORG_NAME_MAX = ORG_NAME_MAX_LENGTH;
