/**
 * LP Journeys data layer.
 * Feature flag LP_CHAT_ENABLED must be ON.
 * 
 * Guest journeys use signed HttpOnly cookies (not Supabase anon login).
 */

import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { isLpChatEnabled } from "@/lib/feature-flags";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const JOURNEY_EXPIRY_HOURS = 24;
const MAX_TURNS_PER_JOURNEY = 50;

export interface Journey {
  id: string;
  tenantId: string;
  tokenHash: string;
  activeAgent: string;
  kbReleaseId: string | null;
  promptVersion: string;
  aiDisclosureAccepted: boolean;
  privacyVersion: string | null;
  expiresAt: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConsentEvent {
  id: string;
  journeyId: string;
  consentType: "ai_disclosure" | "privacy" | "handoff_data_share";
  version: string;
  method: "button_click" | "checkbox" | "form_submit";
  consentedAt: string;
}

function getSigningKey(): string {
  const key = process.env.GUEST_SIGNING_KEY;
  if (!key || key.startsWith("replace_me")) {
    console.warn("[journeys] GUEST_SIGNING_KEY not configured, using fallback");
    return "dev-fallback-key-not-for-production";
  }
  return key;
}

export function generateGuestToken(): { token: string; tokenHash: string } {
  const token = `guest_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashToken(token);
  return { token, tokenHash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function signToken(token: string): string {
  const key = getSigningKey();
  return createHmac("sha256", key).update(token).digest("hex");
}

export function verifySignature(token: string, signature: string): boolean {
  const expected = Buffer.from(signToken(token), "utf8");
  const actual = Buffer.from(signature, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

function mapJourneyRow(row: Record<string, unknown>): Journey {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? DEFAULT_TENANT_ID),
    tokenHash: String(row.token_hash),
    activeAgent: String(row.active_agent ?? "sales"),
    kbReleaseId: row.kb_release_id ? String(row.kb_release_id) : null,
    promptVersion: String(row.prompt_version ?? "v1"),
    aiDisclosureAccepted: Boolean(row.ai_disclosure_accepted),
    privacyVersion: row.privacy_version ? String(row.privacy_version) : null,
    expiresAt: String(row.expires_at),
    turnCount: Number(row.turn_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function createJourney(input: {
  tokenHash: string;
  aiDisclosureAccepted: boolean;
  privacyVersion: string;
  kbReleaseId?: string;
  ipHash?: string;
}): Promise<Journey | null> {
  if (!isLpChatEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    console.error("[journeys] Supabase admin client not configured");
    return null;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + JOURNEY_EXPIRY_HOURS * 60 * 60 * 1000);

  const { data, error } = await admin
    .from("lp_journeys")
    .insert({
      tenant_id: DEFAULT_TENANT_ID,
      token_hash: input.tokenHash,
      active_agent: "sales",
      kb_release_id: input.kbReleaseId || null,
      prompt_version: "v1",
      ai_disclosure_accepted: input.aiDisclosureAccepted,
      privacy_version: input.privacyVersion,
      expires_at: expiresAt.toISOString(),
      turn_count: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[journeys] Failed to create journey:", error);
    return null;
  }

  const journey = mapJourneyRow(data as Record<string, unknown>);

  await admin
    .from("lp_consent_events")
    .insert({
      journey_id: journey.id,
      tenant_id: DEFAULT_TENANT_ID,
      consent_type: "ai_disclosure",
      version: "v1",
      method: "button_click",
      consented_at: now.toISOString(),
      ip_hash: input.ipHash || null,
    });

  if (input.privacyVersion) {
    await admin
      .from("lp_consent_events")
      .insert({
        journey_id: journey.id,
        tenant_id: DEFAULT_TENANT_ID,
        consent_type: "privacy",
        version: input.privacyVersion,
        method: "button_click",
        consented_at: now.toISOString(),
        ip_hash: input.ipHash || null,
      });
  }

  return journey;
}

export async function getJourneyByTokenHash(tokenHash: string): Promise<Journey | null> {
  if (!isLpChatEnabled()) {
    return null;
  }

  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data } = await admin
    .from("lp_journeys")
    .select("*")
    .eq("token_hash", tokenHash)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (!data) {
    return null;
  }

  return mapJourneyRow(data as Record<string, unknown>);
}

export async function incrementTurnCount(journeyId: string): Promise<number | null> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return null;
  }

  const { data } = await admin
    .from("lp_journeys")
    .select("turn_count")
    .eq("id", journeyId)
    .single();

  if (!data) {
    return null;
  }

  const newCount = Number(data.turn_count ?? 0) + 1;

  if (newCount > MAX_TURNS_PER_JOURNEY) {
    return null;
  }

  await admin
    .from("lp_journeys")
    .update({
      turn_count: newCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", journeyId);

  return newCount;
}

export async function recordChatTurn(input: {
  journeyId: string;
  turnNumber: number;
  clientTurnId?: string;
  kbReleaseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  toolCalls?: string[];
}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (!admin) {
    return false;
  }

  const { error } = await admin
    .from("lp_chat_turns")
    .insert({
      journey_id: input.journeyId,
      tenant_id: DEFAULT_TENANT_ID,
      turn_number: input.turnNumber,
      client_turn_id: input.clientTurnId || null,
      kb_release_id: input.kbReleaseId || null,
      input_tokens: input.inputTokens || null,
      output_tokens: input.outputTokens || null,
      model: input.model || null,
      tool_calls: input.toolCalls || null,
      created_at: new Date().toISOString(),
    });

  if (error) {
    if (error.code === "23505") {
      return true;
    }
    console.error("[journeys] Failed to record turn:", error);
    return false;
  }

  return true;
}

export function parseGuestCookie(cookieValue: string): { token: string; signature: string } | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 2) {
    return null;
  }
  return { token: parts[0], signature: parts[1] };
}

export function formatGuestCookieValue(token: string): string {
  const signature = signToken(token);
  return `${token}.${signature}`;
}

/**
 * Full Set-Cookie header string. For `cookies().set(name, value, opts)` use
 * formatGuestCookieValue() instead: that API takes the bare value only.
 */
export function formatGuestCookie(token: string, options?: { maxAgeSeconds?: number }): string {
  const value = formatGuestCookieValue(token);
  const maxAge = options?.maxAgeSeconds ?? 86400; // 24 hours
  return `lp_guest=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export { MAX_TURNS_PER_JOURNEY };
