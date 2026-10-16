import { expect, mock, test } from "bun:test";

let agent: Record<string, unknown> | null = {
  id: "agent",
  status: "linked",
  credential_fingerprint: "fixture-hash",
  credential_generation: 2,
  grok_bot_agent_id: "bot",
};

mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return query;
        },
        update: (patch: Record<string, unknown>) => {
          if (agent && filters.org_id === "org") {
            agent = { ...agent, ...patch };
          }
          return {
            eq: (k: string, v: unknown) => {
              filters[k] = v;
              return {
                select: () => ({
                  maybeSingle: async () => ({
                    data: filters.org_id === "org" ? agent : null,
                    error: null,
                  }),
                  single: async () => ({
                    data: filters.org_id === "org" ? agent : null,
                    error: null,
                  }),
                }),
                maybeSingle: async () => ({
                  data: filters.org_id === "org" ? agent : null,
                  error: null,
                }),
              };
            },
          };
        },
        maybeSingle: async () => ({
          data: filters.org_id === "org" && filters.id === "agent" ? agent : null,
          error: null,
        }),
      };
      return query;
    },
  }),
}));

mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));

const { isApprovalAuthorityCurrent } = await import("./approval-authority");
const { revokeOrgAdminAgent } = await import("@/lib/data/admin-agents");

const approval = {
  orgId: "org",
  employeeId: "",
  credentialId: "",
  purpose: "admin.policy",
  metadata: {
    auditClass: "admin",
    adminRequester: {
      kind: "admin_agent",
      actorId: "agent",
      grokBotAgentId: "bot",
      credentialGeneration: 2,
    },
  },
};

test("revoke makes isApprovalAuthorityCurrent false for the old admin ticket", async () => {
  expect(await isApprovalAuthorityCurrent(approval)).toBe(true);
  await revokeOrgAdminAgent({ orgId: "org" });
  expect(agent?.status).toBe("revoked");
  expect(agent?.credential_fingerprint ?? agent?.credentialFingerprint).toBeNull();
  expect(await isApprovalAuthorityCurrent(approval)).toBe(false);
});
