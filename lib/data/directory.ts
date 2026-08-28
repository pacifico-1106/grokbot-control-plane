/**
 * Org party / channel / information-asset directory (DEMO in-memory + Supabase).
 * Unknown party/channel → caller treats as external. Unknown asset → confidential.
 */

import { DEMO_ORG } from "@/lib/demo-data";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";
import type {
  Audience,
  ChannelClassification,
  ConversationSurface,
  InformationAsset,
  InformationClass,
  OrgChannel,
  OrgParty,
  OrgPartyKind,
} from "@/lib/types";

function nowIso(): string {
  return new Date().toISOString();
}

function demoId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizePartyIdentifier(kind: OrgPartyKind, identifier: string): string {
  const value = identifier.trim();
  if (kind === "email_domain" || kind === "mail_address") return value.toLowerCase();
  if (kind === "phone") return value.replace(/[^\d+]/g, "") || value;
  return value;
}

const PARTY_KINDS: OrgPartyKind[] = [
  "email_domain",
  "slack_channel",
  "slack_user",
  "phone",
  "line",
  "mail_address",
];
const SURFACES: ConversationSurface[] = ["slack", "line", "mail", "phone", "web"];
const CHANNEL_CLASSES: ChannelClassification[] = ["internal", "shared_external", "unknown"];
const INFO_CLASSES: InformationClass[] = ["public", "internal", "confidential", "verbatim"];

function isPartyKind(value: string): value is OrgPartyKind {
  return PARTY_KINDS.includes(value as OrgPartyKind);
}
function isSurface(value: string): value is ConversationSurface {
  return SURFACES.includes(value as ConversationSurface);
}
function isChannelClass(value: string): value is ChannelClassification {
  return CHANNEL_CLASSES.includes(value as ChannelClassification);
}
function isInfoClass(value: string): value is InformationClass {
  return INFO_CLASSES.includes(value as InformationClass);
}

const runtimeParties: OrgParty[] = [
  {
    id: "pty_domain_internal",
    orgId: DEMO_ORG.id,
    kind: "email_domain",
    identifier: "sample-shoji.example",
    audience: "internal",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "pty_domain_example",
    orgId: DEMO_ORG.id,
    kind: "email_domain",
    identifier: "example.com",
    audience: "internal",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "pty_domain_customer",
    orgId: DEMO_ORG.id,
    kind: "email_domain",
    identifier: "customer.example",
    audience: "external",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "pty_mail_owner",
    orgId: DEMO_ORG.id,
    kind: "mail_address",
    identifier: "owner@example.com",
    audience: "internal",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "pty_slack_yamada",
    orgId: DEMO_ORG.id,
    kind: "slack_user",
    identifier: "U_YAMADA",
    audience: "internal",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

const runtimeChannels: OrgChannel[] = [
  {
    id: "chn_internal",
    orgId: DEMO_ORG.id,
    surface: "slack",
    externalId: "C_INTERNAL",
    classification: "internal",
    mixed: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "chn_shared",
    orgId: DEMO_ORG.id,
    surface: "slack",
    externalId: "C_SHARED",
    classification: "shared_external",
    mixed: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

const runtimeAssets: InformationAsset[] = [
  {
    id: "ast_faq",
    orgId: DEMO_ORG.id,
    ref: "kb/public-faq",
    class: "public",
    projectId: "prj_company",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "ast_handbook",
    orgId: DEMO_ORG.id,
    ref: "kb/handbook",
    class: "internal",
    projectId: "prj_company",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "ast_salary",
    orgId: DEMO_ORG.id,
    ref: "kb/salary",
    class: "confidential",
    projectId: "prj_company",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "ast_nda",
    orgId: DEMO_ORG.id,
    ref: "contract/nda",
    class: "verbatim",
    projectId: "prj_company",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
  {
    id: "ast_project_a_plan",
    orgId: DEMO_ORG.id,
    ref: "kb/project-a-plan",
    class: "confidential",
    projectId: "prj_project_a",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  },
];

function mapPartyRow(row: Record<string, unknown>): OrgParty {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    kind: isPartyKind(String(row.kind)) ? (row.kind as OrgPartyKind) : "mail_address",
    identifier: String(row.identifier ?? ""),
    audience: row.audience === "internal" ? "internal" : "external",
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

function mapChannelRow(row: Record<string, unknown>): OrgChannel {
  const classification = isChannelClass(String(row.classification))
    ? (row.classification as ChannelClassification)
    : "unknown";
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    surface: isSurface(String(row.surface)) ? (row.surface as ConversationSurface) : "web",
    externalId: String(row.external_id ?? ""),
    classification,
    mixed: Boolean(row.mixed),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

function mapAssetRow(row: Record<string, unknown>): InformationAsset {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    ref: String(row.ref ?? ""),
    class: isInfoClass(String(row.class)) ? (row.class as InformationClass) : "confidential",
    projectId: row.project_id != null ? String(row.project_id) : null,
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

export async function listOrgParties(orgId?: string | null): Promise<OrgParty[]> {
  if (!orgId) return [];
  if (isDemoMode()) return runtimeParties.filter((row) => row.orgId === orgId);
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_parties")
    .select("*")
    .eq("org_id", orgId)
    .order("kind")
    .order("identifier");
  if (error || !data) return [];
  return data.map((row) => mapPartyRow(row as Record<string, unknown>));
}

export async function getOrgParty(
  orgId: string,
  kind: OrgPartyKind,
  identifier: string
): Promise<OrgParty | null> {
  const normalized = normalizePartyIdentifier(kind, identifier);
  if (!orgId || !normalized) return null;
  if (isDemoMode()) {
    return (
      runtimeParties.find(
        (row) =>
          row.orgId === orgId &&
          row.kind === kind &&
          normalizePartyIdentifier(row.kind, row.identifier) === normalized
      ) ?? null
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_parties")
    .select("*")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("identifier", normalized)
    .maybeSingle();
  if (error || !data) return null;
  return mapPartyRow(data as Record<string, unknown>);
}

export async function upsertOrgParty(input: {
  orgId: string;
  kind: OrgPartyKind;
  identifier: string;
  audience: Exclude<Audience, "unknown">;
}): Promise<OrgParty> {
  if (!isPartyKind(input.kind)) throw new Error("invalid_party_kind");
  const identifier = normalizePartyIdentifier(input.kind, input.identifier);
  if (!identifier) throw new Error("identifier_required");
  const audience = input.audience === "internal" ? "internal" : "external";
  if (isDemoMode()) {
    const existing = runtimeParties.find(
      (row) => row.orgId === input.orgId && row.kind === input.kind && row.identifier === identifier
    );
    if (existing) {
      existing.audience = audience;
      existing.updatedAt = nowIso();
      return existing;
    }
    const row: OrgParty = {
      id: demoId("pty"),
      orgId: input.orgId,
      kind: input.kind,
      identifier,
      audience,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    runtimeParties.unshift(row);
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_parties")
    .upsert(
      {
        org_id: input.orgId,
        kind: input.kind,
        identifier,
        audience,
        updated_at: nowIso(),
      },
      { onConflict: "org_id,kind,identifier" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "party_upsert_failed");
  return mapPartyRow(data as Record<string, unknown>);
}

export async function deleteOrgParty(orgId: string, id: string): Promise<boolean> {
  if (!orgId || !id) return false;
  if (isDemoMode()) {
    const idx = runtimeParties.findIndex((row) => row.id === id && row.orgId === orgId);
    if (idx < 0) return false;
    runtimeParties.splice(idx, 1);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { error } = await admin.from("org_parties").delete().eq("id", id).eq("org_id", orgId);
  return !error;
}

export async function listOrgChannels(orgId?: string | null): Promise<OrgChannel[]> {
  if (!orgId) return [];
  if (isDemoMode()) return runtimeChannels.filter((row) => row.orgId === orgId);
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("org_channels")
    .select("*")
    .eq("org_id", orgId)
    .order("surface")
    .order("external_id");
  if (error || !data) return [];
  return data.map((row) => mapChannelRow(row as Record<string, unknown>));
}

export async function getOrgChannel(
  orgId: string,
  surface: ConversationSurface,
  externalId: string
): Promise<OrgChannel | null> {
  const id = externalId.trim();
  if (!orgId || !id) return null;
  if (isDemoMode()) {
    return (
      runtimeChannels.find(
        (row) => row.orgId === orgId && row.surface === surface && row.externalId === id
      ) ?? null
    );
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("org_channels")
    .select("*")
    .eq("org_id", orgId)
    .eq("surface", surface)
    .eq("external_id", id)
    .maybeSingle();
  if (error || !data) return null;
  return mapChannelRow(data as Record<string, unknown>);
}

export async function upsertOrgChannel(input: {
  orgId: string;
  surface: ConversationSurface;
  externalId: string;
  classification: ChannelClassification;
  mixed?: boolean;
}): Promise<OrgChannel> {
  if (!isSurface(input.surface)) throw new Error("invalid_surface");
  const externalId = input.externalId.trim();
  if (!externalId) throw new Error("external_id_required");
  const classification = isChannelClass(input.classification) ? input.classification : "unknown";
  const mixed = Boolean(input.mixed) || classification === "shared_external";
  const existingChannel = await getOrgChannel(input.orgId, input.surface, externalId);
  if (
    existingChannel &&
    (existingChannel.classification === "shared_external" || existingChannel.mixed) &&
    classification === "internal"
  ) {
    throw new Error("connect_cannot_be_internal");
  }
  if (isDemoMode()) {
    const existing = runtimeChannels.find(
      (row) => row.orgId === input.orgId && row.surface === input.surface && row.externalId === externalId
    );
    if (existing) {
      existing.classification = classification;
      existing.mixed = mixed;
      existing.updatedAt = nowIso();
      return existing;
    }
    const row: OrgChannel = {
      id: demoId("chn"),
      orgId: input.orgId,
      surface: input.surface,
      externalId,
      classification,
      mixed,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    runtimeChannels.unshift(row);
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const { data, error } = await admin
    .from("org_channels")
    .upsert(
      {
        org_id: input.orgId,
        surface: input.surface,
        external_id: externalId,
        classification,
        mixed,
        updated_at: nowIso(),
      },
      { onConflict: "org_id,surface,external_id" }
    )
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "channel_upsert_failed");
  return mapChannelRow(data as Record<string, unknown>);
}

export async function deleteOrgChannel(orgId: string, id: string): Promise<boolean> {
  if (!orgId || !id) return false;
  if (isDemoMode()) {
    const idx = runtimeChannels.findIndex((row) => row.id === id && row.orgId === orgId);
    if (idx < 0) return false;
    runtimeChannels.splice(idx, 1);
    return true;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return false;
  const { error } = await admin.from("org_channels").delete().eq("id", id).eq("org_id", orgId);
  return !error;
}

export async function listInformationAssets(orgId?: string | null): Promise<InformationAsset[]> {
  if (!orgId) return [];
  if (isDemoMode()) return runtimeAssets.filter((row) => row.orgId === orgId);
  const admin = createSupabaseAdminClient();
  if (!admin) return [];
  const { data, error } = await admin
    .from("information_assets")
    .select("*")
    .eq("org_id", orgId)
    .order("ref");
  if (error || !data) return [];
  return data.map((row) => mapAssetRow(row as Record<string, unknown>));
}

export async function getInformationAsset(orgId: string, ref: string): Promise<InformationAsset | null> {
  const key = ref.trim();
  if (!orgId || !key) return null;
  if (isDemoMode()) {
    return runtimeAssets.find((row) => row.orgId === orgId && row.ref === key) ?? null;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from("information_assets")
    .select("*")
    .eq("org_id", orgId)
    .eq("ref", key)
    .maybeSingle();
  if (error || !data) return null;
  return mapAssetRow(data as Record<string, unknown>);
}

export async function upsertInformationAsset(input: {
  orgId: string;
  ref: string;
  class: InformationClass;
  projectId?: string | null;
}): Promise<InformationAsset> {
  const ref = input.ref.trim();
  if (!ref) throw new Error("ref_required");
  const infoClass = isInfoClass(input.class) ? input.class : "confidential";
  const projectId =
    input.projectId === undefined
      ? undefined
      : input.projectId
        ? String(input.projectId).trim() || null
        : null;
  if (isDemoMode()) {
    const existing = runtimeAssets.find((row) => row.orgId === input.orgId && row.ref === ref);
    if (existing) {
      existing.class = infoClass;
      if (projectId !== undefined) existing.projectId = projectId;
      existing.updatedAt = nowIso();
      return existing;
    }
    const row: InformationAsset = {
      id: demoId("ast"),
      orgId: input.orgId,
      ref,
      class: infoClass,
      projectId: projectId ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    runtimeAssets.unshift(row);
    return row;
  }
  const admin = createSupabaseAdminClient();
  if (!admin) throw new Error("supabase_not_configured");
  const payload: Record<string, unknown> = {
    org_id: input.orgId,
    ref,
    class: infoClass,
    updated_at: nowIso(),
  };
  if (projectId !== undefined) payload.project_id = projectId;
  const { data, error } = await admin
    .from("information_assets")
    .upsert(payload, { onConflict: "org_id,ref" })
    .select("*")
    .single();
  if (error || !data) throw new Error(error?.message || "asset_upsert_failed");
  return mapAssetRow(data as Record<string, unknown>);
}
