/** Client lookup for /oauth/authorize and /api/oauth/token (CIMD first; DCR only while its flag is on). */
import { getOAuthStore, type OAuthClientRecord } from "@/lib/data/oauth";
import { resolveCimdClient, isCimdClientId, type CimdDeps } from "@/lib/mcp-oauth/cimd";
import { isMcpOAuthDcrEnabled } from "@/lib/mcp-oauth/config";

export type ClientLookup = { ok: true; client: OAuthClientRecord } | { ok: false; error: string };

export async function lookupOAuthClient(clientId: string, deps: CimdDeps = {}): Promise<ClientLookup> {
  if (!clientId || clientId.length > 512) return { ok: false, error: "invalid_client" };
  if (isCimdClientId(clientId)) {
    const r = await resolveCimdClient(clientId, deps);
    return r.ok ? { ok: true, client: r.client } : { ok: false, error: `cimd_${r.error}` };
  }
  const rec = await getOAuthStore().getClient(clientId);
  if (!rec || rec.status !== "active") return { ok: false, error: "invalid_client" };
  if (rec.registrationType === "dcr" && !isMcpOAuthDcrEnabled()) return { ok: false, error: "dcr_disabled" };
  if (rec.registrationType === "cimd") return { ok: false, error: "invalid_client" };
  return { ok: true, client: rec };
}
