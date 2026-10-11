/** Opaque token minting + hashing (design §9). Only hashes are persisted. */
import { createHash, randomBytes } from "node:crypto";
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX } from "@/lib/mcp-oauth/config";

export function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function mintAccessToken(): { raw: string; hash: string } {
  const raw = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  return { raw, hash: sha256Hex(raw) };
}

export function mintRefreshToken(): { raw: string; hash: string } {
  const raw = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  return { raw, hash: sha256Hex(raw) };
}

export function mintAuthCode(): { raw: string; hash: string } {
  const raw = randomToken(32);
  return { raw, hash: sha256Hex(raw) };
}

/** Audit-safe reference: first 12 hex chars of the hash. Never the token. */
export function hashPrefix(hash: string): string {
  return hash.slice(0, 12);
}

export const isAccessTokenShape = (raw: string) => /^sp_at_[A-Za-z0-9_-]{43}$/.test(raw);
export const isRefreshTokenShape = (raw: string) => /^sp_rt_[A-Za-z0-9_-]{43}$/.test(raw);
