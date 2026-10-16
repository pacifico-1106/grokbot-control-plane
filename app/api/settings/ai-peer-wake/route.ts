import { requireOrgAdminSession } from "@/lib/auth/require-org";
import { webSessionActorMemberId } from "@/lib/approver-authority/web-direct";
import { listEmployees } from "@/lib/data/employees";
import {
  deleteAllowlist,
  listAllowlist,
  listThreads,
  resumePeerWakeThread,
  stopPeerWakeThread,
  upsertAllowlist,
} from "@/lib/data/ai-peer-wake";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  isAiPeerWakeAllowlistEnabled,
  isAiPeerWakeThreadGuardEnabled,
  aiPeerWakeCap,
} from "@/lib/feature-flags";
import { jsonUtf8 } from "@/lib/http/json-utf8";
import { refuseAiCredential, refuseUnsafeBrowserPost } from "@/lib/safety/hold-route";

export const runtime = "nodejs";

async function actorRef(req: Request): Promise<string | null> {
  const id = await webSessionActorMemberId(req);
  return id ? `member:${id}` : null;
}

async function refuseAiOrCsrf(req: Request): Promise<Response | null> {
  const refused = await refuseAiCredential(req, "settings.ai-peer-wake");
  if (refused) return refused;
  return refuseUnsafeBrowserPost(req);
}

export async function GET(req: Request = new Request("https://staffpass.test/api/settings/ai-peer-wake")) {
  const refused = await refuseAiCredential(req, "settings.ai-peer-wake");
  if (refused) return refused;
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const [allowlist, threads, employees] = await Promise.all([
    listAllowlist(gate.orgId),
    listThreads(gate.orgId),
    listEmployees(gate.orgId),
  ]);
  return jsonUtf8({
    ok: true,
    flags: {
      allowlist: isAiPeerWakeAllowlistEnabled(),
      threadGuard: isAiPeerWakeThreadGuardEnabled(),
      cap: aiPeerWakeCap(),
    },
    allowlist,
    threads,
    employees: employees
      .filter((e) => e.orgId === gate.orgId && e.status === "active")
      .map((e) => ({ id: e.id, displayName: e.displayName })),
  });
}

export async function POST(req: Request) {
  const blocked = await refuseAiOrCsrf(req);
  if (blocked) return blocked;
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const actor = await actorRef(req);
  if (!actor) {
    return jsonUtf8({ ok: false, error: "actor_required", message: "操作した人を確認できませんでした" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "allowlist").trim();

  try {
    if (action === "allowlist") {
      const row = await upsertAllowlist({
        orgId: gate.orgId,
        fromEmployeeId: String(body.fromEmployeeId || ""),
        toEmployeeId: String(body.toEmployeeId || ""),
        slackChannelId: body.slackChannelId == null ? null : String(body.slackChannelId),
        createdBy: actor,
        enabled: body.enabled === false ? false : true,
      });
      await appendAuditEvent({
        orgId: gate.orgId,
        employeeId: row.toEmployeeId,
        credentialId: null,
        action: "slack.peer_wake.allowlist_upserted",
        purpose: "slack.peer_wake",
        summary: "AI同士の起動許可を更新した",
        actorEmail: gate.email,
        metadata: {
          allowlistId: row.id,
          fromEmployeeId: row.fromEmployeeId,
          toEmployeeId: row.toEmployeeId,
          slackChannelId: row.slackChannelId,
          enabled: row.enabled,
          actor,
        },
      }).catch(() => undefined);
      return jsonUtf8({ ok: true, allowlist: row });
    }
    if (action === "stop") {
      const result = await stopPeerWakeThread({
        orgId: gate.orgId,
        id: String(body.threadId || ""),
        stopRef: body.stopRef ? String(body.stopRef) : undefined,
        stoppedBy: actor,
      });
      if (result.state === "not_found") {
        return jsonUtf8({ ok: false, error: "not_found", message: "対象の会話が見つかりません" }, { status: 404 });
      }
      if (result.state === "denied" || result.state === "unavailable") {
        return jsonUtf8({ ok: false, error: result.state === "denied" ? result.reason : "unavailable", message: "停止できませんでした" }, { status: 403 });
      }
      await appendAuditEvent({
        orgId: gate.orgId,
        employeeId: null,
        credentialId: null,
        action: "slack.peer_wake.stopped",
        purpose: "slack.peer_wake",
        summary: result.state === "already_stopped" ? "AI同士の会話はすでに停止中" : "人がAI同士の会話を停止した",
        actorEmail: gate.email,
        metadata: { reason: result.state, threadId: result.thread.id, channel: result.thread.slackChannelId, thread_ts: result.thread.threadTs, actor, via: "web" },
      }).catch(() => undefined);
      return jsonUtf8({ ok: true, thread: result.thread, state: result.state });
    }
    if (action === "resume") {
      const result = await resumePeerWakeThread({
        orgId: gate.orgId,
        id: String(body.threadId || ""),
        resumedBy: actor,
      });
      if (result.state === "not_found") {
        return jsonUtf8({ ok: false, error: "not_found", message: "対象の会話が見つかりません" }, { status: 404 });
      }
      if (result.state === "denied" || result.state === "unavailable") {
        return jsonUtf8({ ok: false, error: result.state === "denied" ? result.reason : "unavailable", message: "解除できませんでした" }, { status: 403 });
      }
      await appendAuditEvent({
        orgId: gate.orgId,
        employeeId: null,
        credentialId: null,
        action: "slack.peer_wake.resumed",
        purpose: "slack.peer_wake",
        summary: "人がAI同士の会話停止を解除した",
        actorEmail: gate.email,
        metadata: { reason: result.state, threadId: result.thread.id, channel: result.thread.slackChannelId, thread_ts: result.thread.threadTs, actor, via: "web" },
      }).catch(() => undefined);
      return jsonUtf8({ ok: true, thread: result.thread, state: result.state });
    }
    return jsonUtf8({ ok: false, error: "invalid_action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed";
    const status = message === "employee_not_found" || message === "self_pair" || message === "invalid_channel" || message === "invalid_allowlist" || message === "actor_not_member"
      ? 400
      : 500;
    return jsonUtf8({ ok: false, error: message }, { status });
  }
}

export async function DELETE(req: Request) {
  const blocked = await refuseAiOrCsrf(req);
  if (blocked) return blocked;
  const gate = await requireOrgAdminSession();
  if (!gate.ok) return gate.response;
  const actor = await actorRef(req);
  if (!actor) {
    return jsonUtf8({ ok: false, error: "actor_required", message: "操作した人を確認できませんでした" }, { status: 403 });
  }
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return jsonUtf8({ ok: false, error: "id_required" }, { status: 400 });
  const removed = await deleteAllowlist({ orgId: gate.orgId, id });
  if (!removed) return jsonUtf8({ ok: false, error: "not_found" }, { status: 404 });
  await appendAuditEvent({
    orgId: gate.orgId,
    employeeId: null,
    credentialId: null,
    action: "slack.peer_wake.allowlist_deleted",
    purpose: "slack.peer_wake",
    summary: "AI同士の起動許可を削除した",
    actorEmail: gate.email,
    metadata: { allowlistId: id, actor },
  }).catch(() => undefined);
  return jsonUtf8({ ok: true });
}
