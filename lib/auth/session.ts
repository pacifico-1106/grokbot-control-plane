import { cookies } from "next/headers";
import { isDemoMode } from "../mode";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../supabase";
import { DEMO_ORG } from "../demo-data";
import type { OrgMember } from "../types";
import { mapMemberRow } from "../data/mappers";

export type SessionContext = {
  demo: boolean;
  userId: string | null;
  email: string | null;
  orgId: string | null;
  member: OrgMember | null;
};

const OWNER_CAPS = [
  "view_dashboard",
  "view_employees",
  "view_audit",
  "approve_actions",
  "manage_spend_limits",
  "hire_issue_credentials",
  "manage_team",
  "manage_billing",
];

/** Seed / demo placeholder that must never stick on a real Auth user in production. */
const DEMO_PLACEHOLDER_EMAIL = "owner@example.com";

export function isDemoPlaceholderEmail(email: string | null | undefined): boolean {
  return (email || "").trim().toLowerCase() === DEMO_PLACEHOLDER_EMAIL;
}

/**
 * One-time repair: org_members still has owner@example.com (or similar seed)
 * while auth.users has the real signup email — sync email + display_name.
 */
async function repairDemoPlaceholderMember(
  member: OrgMember,
  sessionEmail: string
): Promise<OrgMember> {
  const admin = createSupabaseAdminClient();
  if (!admin) return member;
  const email = sessionEmail.trim();
  if (!email || isDemoPlaceholderEmail(email)) return member;
  if (!isDemoPlaceholderEmail(member.email)) return member;
  if (member.email.trim().toLowerCase() === email.toLowerCase()) return member;

  const displayName = email.split("@")[0] || email;
  const { data, error } = await admin
    .from("org_members")
    .update({
      email,
      display_name: displayName,
    })
    .eq("id", member.id)
    .select("*")
    .single();

  if (error || !data) {
    console.warn(
      "[auth] repairDemoPlaceholderMember failed:",
      error?.message || "no_data"
    );
    return member;
  }
  return mapMemberRow(data as Record<string, unknown>);
}


/**
 * Current session + org. DEMO: always returns demo org, no auth crash.
 */
export async function getSessionContext(): Promise<SessionContext> {
  if (isDemoMode()) {
    return {
      demo: true,
      userId: null,
      email: "owner@example.com",
      orgId: DEMO_ORG.id,
      member: null,
    };
  }

  try {
    const cookieStore = await cookies();
    const supabase = createSupabaseServerClient({
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options as never);
          });
        } catch {
          /* read-only in some RSC paths */
        }
      },
    });

    if (!supabase) {
      return {
        demo: true,
        userId: null,
        email: null,
        orgId: DEMO_ORG.id,
        member: null,
      };
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return {
        demo: false,
        userId: null,
        email: null,
        orgId: null,
        member: null,
      };
    }

    const admin = createSupabaseAdminClient();
    let member: OrgMember | null = null;
    let orgId: string | null = null;

    if (admin) {
      const { data } = await admin
        .from("org_members")
        .select("*")
        .eq("user_id", user.id)
        .eq("status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (data) {
        member = mapMemberRow(data as Record<string, unknown>);
        orgId = member.orgId;
      }
    }

    return {
      demo: false,
      userId: user.id,
      email: user.email ?? null,
      orgId,
      member,
    };
  } catch {
    return {
      demo: false,
      userId: null,
      email: null,
      orgId: null,
      member: null,
    };
  }
}

/** Convenience: org id for data layer (DEMO → org_demo). */
export async function getCurrentOrgId(): Promise<string | null> {
  const ctx = await getSessionContext();
  return ctx.orgId;
}

function isSchemaMissingError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("does not exist") ||
    m.includes("schema cache") ||
    m.includes("could not find the table") ||
    (m.includes("relation") && (m.includes("orgs") || m.includes("org_members")))
  );
}

/**
 * Provision org + owner member (+ trial subscription / gateway stub) for an
 * existing Auth user. Idempotent if membership already exists.
 * Used by signup and by first-/app login repair when Auth user exists but org insert failed.
 */
export async function provisionOrgForUser(input: {
  userId: string;
  email: string;
  orgName?: string;
  integrationMode?: "managed" | "byo";
  displayName?: string;
  referralCode?: string | null;
}): Promise<{ orgId: string; memberId: string; member: OrgMember }> {
  if (isDemoMode()) {
    throw new Error("demo_mode_no_auth_signup");
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const { data: existing, error: existingErr } = await admin
    .from("org_members")
    .select("*")
    .eq("user_id", input.userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existingErr && isSchemaMissingError(existingErr.message)) {
    throw new Error(existingErr.message);
  }

  if (existing) {
    let member = mapMemberRow(existing as Record<string, unknown>);
    // Never leave seed owner@example.com on a real Auth user's membership.
    if (
      input.email &&
      !isDemoPlaceholderEmail(input.email) &&
      isDemoPlaceholderEmail(member.email)
    ) {
      member = await repairDemoPlaceholderMember(member, input.email);
    }
    return { orgId: member.orgId, memberId: member.id, member };
  }

  const trialDays = Number(process.env.TRIAL_DAYS || "14");
  const trialEnds = new Date(
    Date.now() + trialDays * 86400000
  ).toISOString();

  const referral =
    input.referralCode != null && String(input.referralCode).trim()
      ? String(input.referralCode).trim().toUpperCase()
      : null;

  const { data: org, error: orgErr } = await admin
    .from("orgs")
    .insert({
      name: input.orgName || "新しい組織",
      integration_mode: input.integrationMode || "managed",
      gateway_status: "pending",
      trial_ends_at: trialEnds,
      ...(referral ? { referral_code: referral } : {}),
    })
    .select("*")
    .single();

  if (orgErr || !org) {
    throw new Error(orgErr?.message || "org_create_failed");
  }

  const orgId = String((org as { id: string }).id);

  const { data: memberRow, error: memErr } = await admin
    .from("org_members")
    .insert({
      org_id: orgId,
      user_id: input.userId,
      email: input.email,
      display_name: input.displayName || input.email.split("@")[0],
      role: "owner",
      job_role: "owner",
      capabilities: OWNER_CAPS,
      status: "active",
    })
    .select("*")
    .single();

  if (memErr || !memberRow) {
    throw new Error(memErr?.message || "member_create_failed");
  }

  await admin.from("subscriptions").insert({
    org_id: orgId,
    plan_key: "business",
    status: "trialing",
    trial_ends_at: trialEnds,
  });

  await admin.from("gateway_links").insert({
    org_id: orgId,
    mode: input.integrationMode || "managed",
    status: "pending",
  });

  const member = mapMemberRow(memberRow as Record<string, unknown>);
  return {
    orgId,
    memberId: member.id,
    member,
  };
}

export type EnsureOrgResult =
  | { status: "ok"; session: SessionContext }
  | { status: "unauthenticated" }
  | { status: "needs_schema"; session: SessionContext; error: string }
  | { status: "provision_failed"; session: SessionContext; error: string };

/**
 * For /app layout: authenticated users without org_members get an org
 * auto-provisioned (same shape as signup). Never throws — soft status only.
 */
export async function ensureAuthenticatedOrg(): Promise<EnsureOrgResult> {
  if (isDemoMode()) {
    return {
      status: "ok",
      session: await getSessionContext(),
    };
  }

  const session = await getSessionContext();
  if (!session.userId) {
    return { status: "unauthenticated" };
  }
  if (session.orgId && session.member) {
    if (
      session.email &&
      !isDemoPlaceholderEmail(session.email) &&
      isDemoPlaceholderEmail(session.member.email)
    ) {
      const repaired = await repairDemoPlaceholderMember(
        session.member,
        session.email
      );
      return {
        status: "ok",
        session: { ...session, member: repaired },
      };
    }
    return { status: "ok", session };
  }

  try {
    const provisioned = await provisionOrgForUser({
      userId: session.userId,
      email: session.email || "owner@unknown.local",
      orgName: "新しい組織",
      displayName: session.email?.split("@")[0],
    });
    return {
      status: "ok",
      session: {
        ...session,
        orgId: provisioned.orgId,
        member: provisioned.member,
      },
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "provision_failed";
    if (isSchemaMissingError(message)) {
      return { status: "needs_schema", session, error: message };
    }
    return { status: "provision_failed", session, error: message };
  }
}

/**
 * Signup bootstrap: auth user + org + owner member.
 * Only runs when Supabase is configured; DEMO callers should skip.
 * If Auth user is created but org insert fails, Auth user is left in place —
 * next /app visit (ensureAuthenticatedOrg) or /api/auth/repair-org repairs it.
 */
export async function createOrgWithOwner(input: {
  email: string;
  password: string;
  orgName: string;
  integrationMode?: "managed" | "byo";
  displayName?: string;
  /** Optional partner code AIC-XXXX (Kimura stage 2). */
  referralCode?: string | null;
}): Promise<{
  userId: string;
  orgId: string;
  memberId: string;
}> {
  if (isDemoMode()) {
    throw new Error("demo_mode_no_auth_signup");
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });

  let userId: string;

  if (authErr || !created.user) {
    const msg = authErr?.message || "auth_user_create_failed";
    // Orphan / retry path: Auth user already exists from a prior failed signup.
    if (/already|registered|exists/i.test(msg)) {
      throw new Error(`email_exists:${msg}`);
    }
    throw new Error(msg);
  } else {
    userId = created.user.id;
  }

  try {
    const provisioned = await provisionOrgForUser({
      userId,
      email: input.email,
      orgName: input.orgName,
      integrationMode: input.integrationMode,
      displayName: input.displayName,
      referralCode: input.referralCode,
    });
    return {
      userId,
      orgId: provisioned.orgId,
      memberId: provisioned.memberId,
    };
  } catch (e) {
    // Auth user remains; caller / login repair must finish org provisioning.
    const message = e instanceof Error ? e.message : "org_create_failed";
    throw new Error(`auth_ok_org_failed:${message}`);
  }
}
