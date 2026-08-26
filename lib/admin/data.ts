import "server-only";

import type { SuperAdminActor } from "@/lib/admin/access";
import { createSupabaseAdminClient } from "@/lib/supabase";

type Row = Record<string, unknown>;

export type AdminOrganizationStatus =
  | "active"
  | "trialing"
  | "attention"
  | "onboarding"
  | "quiet";

export type AdminOrganization = {
  id: string;
  name: string;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: string;
  trialEndsAt: string | null;
  subscriptionStatus: string;
  planKey: string;
  gatewayStatus: string;
  integrationMode: string;
  referralCode: string | null;
  memberCount: number;
  employeeCount: number;
  pendingApprovals: number;
  actionsThisMonth: number;
  lastActivityAt: string | null;
  status: AdminOrganizationStatus;
};

export type AdminOverview = {
  organizations: AdminOrganization[];
  totals: {
    organizations: number;
    signupsLast30Days: number;
    activeSubscriptions: number;
    trialingSubscriptions: number;
    activeOrganizationsLast30Days: number;
    attentionNeeded: number;
    employees: number;
    actionsThisMonth: number;
  };
};

export type AdminOrganizationDetail = {
  organization: AdminOrganization;
  members: Array<{
    id: string;
    email: string;
    displayName: string;
    role: string;
    status: string;
    createdAt: string;
  }>;
  employees: Array<{
    id: string;
    displayName: string;
    roleLabel: string;
    status: string;
    createdAt: string;
  }>;
  recentEvents: Array<{
    id: string;
    action: string;
    summary: string;
    actorEmail: string | null;
    createdAt: string;
  }>;
};

function stringOrNull(value: unknown): string | null {
  return value == null || String(value).trim() === "" ? null : String(value);
}

function dateMs(value: unknown): number {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function requireAdminClient() {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("super_admin_requires_production_mode");
  return admin;
}

function assertQuery(error: { message: string } | null, source: string): void {
  if (error) throw new Error(`super_admin_${source}_query_failed:${error.message}`);
}

function currentMonth(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `${year}-${month}`;
}

function deriveStatus(input: {
  subscriptionStatus: string;
  trialEndsAt: string | null;
  gatewayStatus: string;
  lastActivityAt: string | null;
  createdAt: string;
}): AdminOrganizationStatus {
  if (["past_due", "unpaid", "incomplete"].includes(input.subscriptionStatus)) {
    return "attention";
  }
  if (
    input.subscriptionStatus === "trialing" &&
    input.trialEndsAt &&
    dateMs(input.trialEndsAt) < Date.now()
  ) {
    return "attention";
  }
  if (input.gatewayStatus === "disconnected") return "attention";
  if (
    !input.lastActivityAt &&
    dateMs(input.createdAt) < Date.now() - 7 * 86400000
  ) {
    return "quiet";
  }
  if (input.subscriptionStatus === "active") return "active";
  if (input.subscriptionStatus === "trialing") return "trialing";
  if (input.gatewayStatus === "pending") return "onboarding";
  if (!input.lastActivityAt) return "quiet";
  return "onboarding";
}

async function loadOrganizations(): Promise<AdminOverview> {
  const admin = requireAdminClient();
  const activitySince = new Date(Date.now() - 30 * 86400000).toISOString();

  const [orgResult, memberResult, employeeResult, subscriptionResult, approvalResult, counterResult, auditResult, gatewayResult] =
    await Promise.all([
      admin.from("orgs").select("id,name,integration_mode,gateway_status,trial_ends_at,referral_code,created_at").order("created_at", { ascending: false }).limit(1000),
      admin.from("org_members").select("id,org_id,email,display_name,role,status,created_at").order("created_at", { ascending: true }).limit(10000),
      admin.from("employees").select("id,org_id,status").limit(10000),
      admin.from("subscriptions").select("org_id,plan_key,status,trial_ends_at,updated_at").limit(2000),
      admin.from("approval_requests").select("org_id,status").eq("status", "pending").limit(10000),
      admin.from("action_counters").select("org_id,count").eq("period", currentMonth()).limit(10000),
      admin.from("audit_events").select("org_id,created_at").gte("created_at", activitySince).order("created_at", { ascending: false }).limit(10000),
      admin.from("gateway_links").select("org_id,status,updated_at").limit(2000),
    ]);

  assertQuery(orgResult.error, "organizations");
  assertQuery(memberResult.error, "members");
  assertQuery(employeeResult.error, "employees");
  assertQuery(subscriptionResult.error, "subscriptions");
  assertQuery(approvalResult.error, "approvals");
  assertQuery(counterResult.error, "counters");
  assertQuery(auditResult.error, "audit");
  assertQuery(gatewayResult.error, "gateways");

  const orgRows = (orgResult.data || []) as Row[];
  const memberRows = (memberResult.data || []) as Row[];
  const employeeRows = (employeeResult.data || []) as Row[];
  const subscriptionRows = (subscriptionResult.data || []) as Row[];
  const approvalRows = (approvalResult.data || []) as Row[];
  const counterRows = (counterResult.data || []) as Row[];
  const auditRows = (auditResult.data || []) as Row[];
  const gatewayRows = (gatewayResult.data || []) as Row[];

  const counts = <T extends Row>(rows: T[], key: string) => {
    const result = new Map<string, number>();
    for (const row of rows) {
      const id = String(row[key] || "");
      if (id) result.set(id, (result.get(id) || 0) + 1);
    }
    return result;
  };

  const membersByOrg = counts(memberRows, "org_id");
  const employeesByOrg = counts(employeeRows, "org_id");
  const approvalsByOrg = counts(approvalRows, "org_id");
  const actionsByOrg = new Map<string, number>();
  for (const row of counterRows) {
    const orgId = String(row.org_id || "");
    actionsByOrg.set(orgId, (actionsByOrg.get(orgId) || 0) + Number(row.count || 0));
  }

  const ownerByOrg = new Map<string, Row>();
  for (const row of memberRows) {
    const orgId = String(row.org_id || "");
    if (!ownerByOrg.has(orgId) || row.role === "owner") ownerByOrg.set(orgId, row);
  }
  const subscriptionByOrg = new Map(subscriptionRows.map((row) => [String(row.org_id), row]));
  const gatewayByOrg = new Map(gatewayRows.map((row) => [String(row.org_id), row]));
  const lastActivityByOrg = new Map<string, string>();
  for (const row of auditRows) {
    const orgId = String(row.org_id || "");
    if (!lastActivityByOrg.has(orgId)) lastActivityByOrg.set(orgId, String(row.created_at));
  }

  const organizations = orgRows.map((row): AdminOrganization => {
    const id = String(row.id);
    const owner = ownerByOrg.get(id);
    const subscription = subscriptionByOrg.get(id);
    const gateway = gatewayByOrg.get(id);
    const subscriptionStatus = String(subscription?.status || "none");
    const trialEndsAt = stringOrNull(subscription?.trial_ends_at ?? row.trial_ends_at);
    const gatewayStatus = String(gateway?.status || row.gateway_status || "pending");
    const lastActivityAt = lastActivityByOrg.get(id) || null;

    return {
      id,
      name: String(row.name || "名称未設定"),
      ownerEmail: stringOrNull(owner?.email),
      ownerName: stringOrNull(owner?.display_name),
      createdAt: String(row.created_at),
      trialEndsAt,
      subscriptionStatus,
      planKey: String(subscription?.plan_key || "—"),
      gatewayStatus,
      integrationMode: String(row.integration_mode || "managed"),
      referralCode: stringOrNull(row.referral_code),
      memberCount: membersByOrg.get(id) || 0,
      employeeCount: employeesByOrg.get(id) || 0,
      pendingApprovals: approvalsByOrg.get(id) || 0,
      actionsThisMonth: actionsByOrg.get(id) || 0,
      lastActivityAt,
      status: deriveStatus({
        subscriptionStatus,
        trialEndsAt,
        gatewayStatus,
        lastActivityAt,
        createdAt: String(row.created_at),
      }),
    };
  });

  const signupSince = Date.now() - 30 * 86400000;
  return {
    organizations,
    totals: {
      organizations: organizations.length,
      signupsLast30Days: organizations.filter((org) => dateMs(org.createdAt) >= signupSince).length,
      activeSubscriptions: organizations.filter((org) => org.subscriptionStatus === "active").length,
      trialingSubscriptions: organizations.filter((org) => org.subscriptionStatus === "trialing").length,
      activeOrganizationsLast30Days: organizations.filter((org) => org.lastActivityAt).length,
      attentionNeeded: organizations.filter((org) => org.status === "attention").length,
      employees: organizations.reduce((sum, org) => sum + org.employeeCount, 0),
      actionsThisMonth: organizations.reduce((sum, org) => sum + org.actionsThisMonth, 0),
    },
  };
}

export async function getAdminOverview(actor: SuperAdminActor): Promise<AdminOverview> {
  void actor;
  return loadOrganizations();
}

export async function getAdminOrganizationDetail(
  actor: SuperAdminActor,
  orgId: string
): Promise<AdminOrganizationDetail | null> {
  void actor;
  const overview = await loadOrganizations();
  const organization = overview.organizations.find((org) => org.id === orgId);
  if (!organization) return null;

  const admin = requireAdminClient();
  const [memberResult, employeeResult, eventResult] = await Promise.all([
    admin.from("org_members").select("id,email,display_name,role,status,created_at").eq("org_id", orgId).order("created_at", { ascending: true }).limit(250),
    admin.from("employees").select("id,display_name,role_label,status,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(250),
    admin.from("audit_events").select("id,action,summary,actor_email,created_at").eq("org_id", orgId).order("created_at", { ascending: false }).limit(100),
  ]);
  assertQuery(memberResult.error, "organization_members");
  assertQuery(employeeResult.error, "organization_employees");
  assertQuery(eventResult.error, "organization_events");

  return {
    organization,
    members: ((memberResult.data || []) as Row[]).map((row) => ({
      id: String(row.id),
      email: String(row.email || ""),
      displayName: String(row.display_name || ""),
      role: String(row.role || "member"),
      status: String(row.status || "active"),
      createdAt: String(row.created_at),
    })),
    employees: ((employeeResult.data || []) as Row[]).map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name || ""),
      roleLabel: String(row.role_label || ""),
      status: String(row.status || "draft"),
      createdAt: String(row.created_at),
    })),
    recentEvents: ((eventResult.data || []) as Row[]).map((row) => ({
      id: String(row.id),
      action: String(row.action || ""),
      summary: String(row.summary || ""),
      actorEmail: stringOrNull(row.actor_email),
      createdAt: String(row.created_at),
    })),
  };
}
