/** In-memory SpamStore for unit tests (no I/O). */
import type { SpamFacts } from "./score";
import type { SpamActionRecord, SpamActionRow, SpamAuditInput, SpamStore, TargetOrg } from "./store";

export type MemorySpamStore = SpamStore & {
  orgs: TargetOrg[];
  facts: SpamFacts[];
  actions: Array<SpamActionRecord & { row?: SpamActionRow }>;
  audits: SpamAuditInput[];
  reports: Array<{ id: string; proposal?: string; candidateCount: number }>;
  calls: string[];
  failOn?: string;
};

export function createMemorySpamStore(init: { orgs?: TargetOrg[]; facts?: SpamFacts[]; actions?: SpamActionRecord[] } = {}): MemorySpamStore {
  const s: MemorySpamStore = {
    orgs: init.orgs ?? [],
    facts: init.facts ?? [],
    actions: [...(init.actions ?? [])],
    audits: [],
    reports: [],
    calls: [],
    async scanFacts() { s.calls.push("scanFacts"); return s.facts; },
    async loadTargets(ids) {
      s.calls.push("loadTargets");
      return s.orgs.filter((o) => ids.includes(o.orgId)).map((o) => structuredClone(o));
    },
    async listActions(ids) { return s.actions.filter((a) => ids.includes(a.orgId)); },
    async banUser(uid) {
      s.calls.push(`ban:${uid}`);
      if (s.failOn === `ban:${uid}`) throw new Error("ban_failed");
      for (const o of s.orgs) for (const u of o.users) if (u.userId === uid) u.bannedUntil = "2126-01-01T00:00:00Z";
    },
    async unbanUser(uid) {
      s.calls.push(`unban:${uid}`);
      for (const o of s.orgs) for (const u of o.users) if (u.userId === uid) u.bannedUntil = null;
    },
    async setMemberStatus(ids, from, to) {
      s.calls.push(`members:${from}->${to}:${ids.length}`);
      let n = 0;
      for (const o of s.orgs) for (const m of o.members) if (ids.includes(m.memberId) && m.status === from) { m.status = to; n++; }
      return n;
    },
    async deleteOrg(orgId) {
      s.calls.push(`deleteOrg:${orgId}`);
      const before = s.orgs.length;
      s.orgs = s.orgs.filter((o) => o.orgId !== orgId);
      return s.orgs.length === before - 1;
    },
    async deleteAuthUser(uid) { s.calls.push(`deleteUser:${uid}`); },
    async insertAction(row) {
      s.calls.push(`ledger:${row.action}:${row.orgId}`);
      s.actions.push({ orgId: row.orgId, action: row.action, createdAt: new Date().toISOString(), row });
    },
    async insertReport(row) {
      const id = `rep_${s.reports.length + 1}`;
      s.reports.push({ id, candidateCount: row.candidateCount });
      return id;
    },
    async setReportProposal(id, approvalId) {
      const r = s.reports.find((x) => x.id === id);
      if (r) r.proposal = approvalId;
    },
    async appendAudit(input) { s.calls.push(`audit:${input.action}:${input.orgId}`); s.audits.push(input); },
  };
  return s;
}

export function spamOrg(orgId: string, userId: string, over: Partial<TargetOrg> = {}): TargetOrg {
  return {
    orgId,
    name: "株式会社サンプル商事",
    referralCode: "QWERTYUIOPASDF",
    stripeCustomerId: null,
    hasStripeSubscription: false,
    employeeCount: 0,
    members: [{ memberId: `m-${orgId.slice(0, 8)}`, userId, role: "owner", status: "active" }],
    users: [{ userId, bannedUntil: null, otherOrgIds: [] }],
    ...over,
  };
}
