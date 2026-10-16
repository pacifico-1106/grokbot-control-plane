/**
 * HTTP adapter for /api/admin/notices. Super-admin cookie session only.
 * AI credential headers are refused as ai_cannot_publish before anything else.
 * Route files stay free of body-field names so they cannot log or parse them.
 */
import type { SuperAdminAccess } from "@/lib/admin/access";
import { getSessionContext } from "@/lib/auth/session";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { isOperatorNoticesEnabled } from "@/lib/feature-flags";
import { aiCredentialPresented, refuseUnsafeBrowserPost } from "@/lib/safety/hold-route";
import {
  correctOperatorNotice,
  getOperatorNoticeBundle,
  listNoticeTargetPicker,
  listOperatorNoticeReceipts,
  listOperatorNoticeReceiptsCsv,
  listOperatorNoticesWithStats,
  previewOperatorNotice,
  publishOperatorNotice,
  saveOperatorNoticeDraft,
  summarizeReceipts,
  withdrawOperatorNotice,
  type AdminFail,
  type AdminFailCode,
  type DraftInput,
  type OperatorActor,
} from "./admin";
import { isNoticeApplyMode, isNoticeAudienceScope, isNoticeSeverity, type NoticeVersionKind } from "./types";

export function refuseAiPublish(req: Request): Response | null {
  if (!aiCredentialPresented(req)) return null;
  console.warn("operator_notice_ai_refused", { route: "admin.notices" });
  return jsonUtf8(
    {
      ok: false,
      error: "ai_cannot_publish",
      message: "AI はお知らせを公開できません。運営が画面から操作してください。",
    },
    { status: 403 }
  );
}

function failStatus(code: AdminFailCode): number {
  if (code === "feature_disabled" || code === "not_found") return 404;
  if (code === "login_too_old" || code === "confirm_required" || code === "warnings_unacked") return 403;
  if (code === "unavailable") return 503;
  if (code === "secret_detected_in_payload") return 400;
  return 400;
}

function failJson(fail: AdminFail): Response {
  return jsonUtf8(
    { ok: false, error: fail.code, ...(fail.messageJa ? { message: fail.messageJa } : {}) },
    { status: failStatus(fail.code) }
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function parseDraft(body: Record<string, unknown>): DraftInput {
  const targetsRaw = Array.isArray(body.targets) ? body.targets : [];
  const flagsRaw = Array.isArray(body.relatedFlags) ? body.relatedFlags : [];
  const itemsRaw = Array.isArray(body.relatesToItemIds) ? body.relatesToItemIds : [];
  const audience = str(body.audienceScope);
  const severityRaw = str(body.severity);
  const applyRaw = str(body.applyMode);
  return {
    id: str(body.id) || undefined,
    title: str(body.title),
    changeSummary: str(body.changeSummary),
    aiUsageChange: str(body.aiUsageChange),
    audienceScope: isNoticeAudienceScope(audience) ? audience : (audience as DraftInput["audienceScope"]),
    sticky: bool(body.sticky, false),
    severity: isNoticeSeverity(severityRaw) ? severityRaw : undefined,
    applyMode: isNoticeApplyMode(applyRaw) ? applyRaw : undefined,
    showToTenantAdmin: body.showToTenantAdmin === undefined ? true : bool(body.showToTenantAdmin, true),
    relatedFlags: flagsRaw.filter((f): f is string => typeof f === "string"),
    targets: targetsRaw.flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const row = t as Record<string, unknown>;
      const orgId = str(row.orgId).trim();
      if (!orgId) return [];
      const employeeId = str(row.employeeId).trim();
      return [{ orgId, employeeId: employeeId || null }];
    }),
    effectiveAt: str(body.effectiveAt) || undefined,
    expiresAt: body.expiresAt === null ? null : str(body.expiresAt) || undefined,
    relatesToItemIds: itemsRaw.filter((x): x is string => typeof x === "string"),
  };
}

async function actorFromAccess(access: SuperAdminAccess): Promise<OperatorActor> {
  if (!access.allowed) return { userId: "", email: "", lastSignInAt: null };
  const session = await getSessionContext().catch(() => null);
  return {
    userId: access.actor.userId,
    email: access.actor.email,
    lastSignInAt: session?.lastSignInAt ?? null,
  };
}

async function gate(
  req: Request,
  access: SuperAdminAccess,
  mutating: boolean
): Promise<{ actor: OperatorActor } | { response: Response }> {
  if (mutating) {
    const unsafe = refuseUnsafeBrowserPost(req);
    if (unsafe) return { response: unsafe };
  }
  if (!isOperatorNoticesEnabled()) {
    return { response: jsonUtf8({ ok: false, error: "feature_disabled" }, { status: 404 }) };
  }
  if (!access.allowed) {
    return {
      response: jsonUtf8(
        { ok: false, error: access.reason === "unauthenticated" ? "auth_required" : "forbidden" },
        { status: access.reason === "unauthenticated" ? 401 : 403 }
      ),
    };
  }
  return { actor: await actorFromAccess(access) };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export async function handleNoticesCollection(
  method: "GET" | "POST",
  req: Request,
  access: SuperAdminAccess
): Promise<Response> {
  const gated = await gate(req, access, method !== "GET");
  if ("response" in gated) return gated.response;
  if (method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("picker") === "1") {
      const picker = await listNoticeTargetPicker();
      if (!picker.ok) return failJson(picker);
      return jsonUtf8({ ok: true, picker: picker.picker });
    }
    const listed = await listOperatorNoticesWithStats(gated.actor);
    if (!listed.ok) return failJson(listed);
    return jsonUtf8({
      ok: true,
      notices: listed.rows.map((r) => ({
        id: r.notice.id,
        seq: r.notice.seq,
        version: r.notice.version,
        status: r.notice.status,
        severity: r.notice.severity,
        audienceScope: r.notice.audienceScope,
        publishedAt: r.notice.publishedAt,
        updatedAt: r.notice.updatedAt,
        title: r.notice.title,
        stats: r.stats,
      })),
    });
  }
  const saved = await saveOperatorNoticeDraft(gated.actor, parseDraft(await readBody(req)));
  if (!saved.ok) return failJson(saved);
  return jsonUtf8({ ok: true, notice: saved.notice });
}

export async function handleNoticeItem(
  method: "GET" | "POST",
  req: Request,
  access: SuperAdminAccess,
  id: string
): Promise<Response> {
  const gated = await gate(req, access, method !== "GET");
  if ("response" in gated) return gated.response;
  if (method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("format") === "csv") {
      const csv = await listOperatorNoticeReceiptsCsv(gated.actor, { noticeId: id });
      if (!csv.ok) return failJson(csv);
      return new Response(csv.csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${id}-receipts.csv"`,
        },
      });
    }
    const bundle = await getOperatorNoticeBundle(gated.actor, id);
    if (!bundle.ok) return failJson(bundle);
    const receipts = await listOperatorNoticeReceipts(gated.actor, id);
    if (!receipts.ok) return failJson(receipts);
    return jsonUtf8({
      ok: true,
      notice: bundle.notice,
      targets: bundle.targets,
      receipts: receipts.receipts,
      stats: summarizeReceipts(receipts.receipts),
    });
  }
  const body = await readBody(req);
  const intent = str(body.intent);
  if (intent === "preview") {
    const preview = await previewOperatorNotice(gated.actor, {
      noticeId: id,
      orgId: str(body.orgId).trim(),
      employeeId: str(body.employeeId).trim(),
    });
    if (!preview.ok) return failJson(preview);
    return jsonUtf8(preview);
  }
  if (intent === "withdraw") {
    const withdrawn = await withdrawOperatorNotice(gated.actor, {
      noticeId: id,
      confirmed: bool(body.confirmed, false),
    });
    if (!withdrawn.ok) return failJson(withdrawn);
    return jsonUtf8({ ok: true, notice: withdrawn.notice });
  }
  if (intent === "correct") {
    const kindRaw = str(body.kind);
    const kind: NoticeVersionKind = kindRaw === "minor" ? "minor" : "correction";
    const applyRaw = str(body.applyMode);
    const audienceRaw = str(body.audienceScope);
    const corrected = await correctOperatorNotice(gated.actor, {
      noticeId: id,
      kind,
      changeNote: str(body.changeNote),
      title: str(body.title),
      changeSummary: str(body.changeSummary),
      aiUsageChange: str(body.aiUsageChange),
      applyMode: isNoticeApplyMode(applyRaw) ? applyRaw : undefined,
      audienceScope: isNoticeAudienceScope(audienceRaw) ? audienceRaw : undefined,
      confirmed: bool(body.confirmed, false),
      acknowledgeWarnings: bool(body.acknowledgeWarnings, false),
    });
    if (!corrected.ok) return failJson(corrected);
    return jsonUtf8({ ok: true, notice: corrected.notice, storedKind: corrected.storedKind });
  }
  const saved = await saveOperatorNoticeDraft(gated.actor, { ...parseDraft(body), id });
  if (!saved.ok) return failJson(saved);
  return jsonUtf8({ ok: true, notice: saved.notice });
}

export async function handleNoticePublish(
  req: Request,
  access: SuperAdminAccess,
  id: string
): Promise<Response> {
  const gated = await gate(req, access, true);
  if ("response" in gated) return gated.response;
  const body = await readBody(req);
  const published = await publishOperatorNotice(gated.actor, {
    noticeId: id,
    confirmed: bool(body.confirmed, false),
    acknowledgeWarnings: bool(body.acknowledgeWarnings, false),
  });
  if (!published.ok) return failJson(published);
  return jsonUtf8({ ok: true, notice: published.notice, warnings: published.warnings });
}
