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

/**
 * Signup bootstrap: auth user + org + owner member.
 * Only runs when Supabase is configured; DEMO callers should skip.
 */
export async function createOrgWithOwner(input: {
  email: string;
  password: string;
  orgName: string;
  integrationMode?: "managed" | "byo";
  displayName?: string;
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
  if (authErr || !created.user) {
    throw new Error(authErr?.message || "auth_user_create_failed");
  }

  const userId = created.user.id;
  const trialDays = Number(process.env.TRIAL_DAYS || "14");
  const trialEnds = new Date(
    Date.now() + trialDays * 86400000
  ).toISOString();

  const { data: org, error: orgErr } = await admin
    .from("orgs")
    .insert({
      name: input.orgName,
      integration_mode: input.integrationMode || "managed",
      gateway_status: "pending",
      trial_ends_at: trialEnds,
    })
    .select("*")
    .single();

  if (orgErr || !org) {
    throw new Error(orgErr?.message || "org_create_failed");
  }

  const orgId = String((org as { id: string }).id);

  const ownerCaps = [
    "view_dashboard",
    "view_employees",
    "view_audit",
    "approve_actions",
    "manage_spend_limits",
    "hire_issue_credentials",
    "manage_team",
    "manage_billing",
  ];

  const { data: member, error: memErr } = await admin
    .from("org_members")
    .insert({
      org_id: orgId,
      user_id: userId,
      email: input.email,
      display_name: input.displayName || input.email.split("@")[0],
      role: "owner",
      job_role: "owner",
      capabilities: ownerCaps,
      status: "active",
    })
    .select("*")
    .single();

  if (memErr || !member) {
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

  return {
    userId,
    orgId,
    memberId: String((member as { id: string }).id),
  };
}
