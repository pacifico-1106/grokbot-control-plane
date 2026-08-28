import { NextResponse } from "next/server";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import {
  appendAuditEvent,
  getApprovalByTelegramMessageId,
  getApprovalByTelegramRef,
  getEmployee,
  shouldUseGlobalTelegramFallback,
  resolveApproval,
  updateApprovalTelegramState,
} from "@/lib/data";
import {
  answerTelegramCallback,
  promptTelegramRevision,
  sendTelegramText,
} from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  chat?: { id?: number };
  from?: TelegramUser;
  reply_to_message?: { message_id?: number };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  callback_query?: {
    id?: string;
    data?: string;
    from?: TelegramUser;
    message?: TelegramMessage;
  };
};

function allowedUserIds(): Set<number> {
  return new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter(Number.isSafeInteger)
  );
}

function actorFor(user: TelegramUser | undefined): string {
  return `telegram:${user?.id ?? "unknown"}`;
}

function isExpectedChat(message: TelegramMessage | undefined): boolean {
  const configured = process.env.TELEGRAM_APPROVAL_CHAT_ID?.trim() || "";
  return Boolean(configured && String(message?.chat?.id ?? "") === configured);
}

function isAllowedUser(user: TelegramUser | undefined): boolean {
  if (!Number.isSafeInteger(user?.id)) return false;
  const allowed = allowedUserIds();
  return allowed.size === 0 || allowed.has(user!.id!);
}

async function auditTelegramError(
  approval: Awaited<ReturnType<typeof getApprovalByTelegramRef>>,
  error: unknown,
  actor: string
) {
  if (!approval) return;
  await appendAuditEvent({
    orgId: approval.orgId,
    employeeId: approval.employeeId,
    credentialId: approval.credentialId,
    actorEmail: actor,
    action: "approval.telegram_error",
    purpose: approval.purpose,
    summary: "Telegram 承認処理エラー",
    metadata: {
      approvalId: approval.id,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

async function handleCallback(update: TelegramUpdate): Promise<void> {
  const query = update.callback_query!;
  const actor = actorFor(query.from);
  const callbackId = query.id || "";
  const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(query.data || "");
  if (!match) {
    await answerTelegramCallback(callbackId, "無効な操作です");
    return;
  }

  // Lookup by telegramRef FIRST so a chat-id / message-id mismatch cannot
  // swallow the callback before the pending ticket is found.
  let approval: Awaited<ReturnType<typeof getApprovalByTelegramRef>> = null;
  let answered = false;
  const answer = async (text: string) => {
    answered = true;
    await answerTelegramCallback(callbackId, text);
  };
  try {
    approval = await getApprovalByTelegramRef(match[2]);
    if (!isAllowedUser(query.from)) {
      await answer("この操作は許可されていません");
      return;
    }
    if (!approval || approval.status !== "pending") {
      await answer("対象は処理済みか見つかりません");
      return;
    }

    const expectedChat = isExpectedChat(query.message);
    const fallback = await shouldUseGlobalTelegramFallback(approval.orgId);
    if (!expectedChat && !fallback) {
      await answer("この操作は許可されていません");
      return;
    }

    if (approval.telegramMessageId !== query.message?.message_id) {
      console.warn("telegram_callback_message_id_mismatch", {
        approvalId: approval.id,
        expected: approval.telegramMessageId,
        got: query.message?.message_id,
      });
    }

    if (match[1] === "e") {
      const prompted = await promptTelegramRevision(approval, query.from!.id!);
      await answer(
        prompted.ok ? "返信で修正指示を送ってください" : "修正モードにできませんでした"
      );
      if (!prompted.ok) {
        await auditTelegramError(approval, prompted.error, actor);
      }
      return;
    }

    const decision = match[1] === "a" ? "approved" : "rejected";
    const updated = await resolveApproval(
      approval.id,
      decision,
      actor,
      approval.orgId
    );
    if (!updated) {
      await answer("対象はすでに処理済みです");
      return;
    }
    await fulfillIfApproved(updated, decision);
    const employee = await getEmployee(updated.employeeId, updated.orgId);
    await runApprovalResolveSideEffects({
      approval: updated,
      decision,
      actorEmail: actor,
      employee,
    });
    await answer(decision === "approved" ? "承認しました" : "却下しました");
  } catch (error) {
    await auditTelegramError(approval, error, actor);
    if (!answered) await answer("処理に失敗しました");
  }
}

async function handleReply(update: TelegramUpdate): Promise<void> {
  const message = update.message!;
  if (!isExpectedChat(message) || !isAllowedUser(message.from)) return;
  const replyTo = Number(message.reply_to_message?.message_id);
  const note = message.text?.trim() || "";
  if (!Number.isSafeInteger(replyTo) || !note) return;

  const approval = await getApprovalByTelegramMessageId(replyTo);
  const actor = actorFor(message.from);
  try {
    const awaiting = Number(approval?.metadata.awaiting_revision_from);
    if (
      !approval ||
      !(await shouldUseGlobalTelegramFallback(approval.orgId)) ||
      approval.status !== "pending" ||
      awaiting !== message.from?.id
    ) {
      await sendTelegramText("対象が見つかりません", message.message_id);
      return;
    }
    if (Array.from(note).length > 2_000) {
      await sendTelegramText(
        "修正指示は2000文字以内で送ってください",
        message.message_id
      );
      return;
    }

    await updateApprovalTelegramState(approval, { awaitingRevisionFrom: null });
    const updated = await resolveApproval(
      approval.id,
      "revision_requested",
      actor,
      approval.orgId,
      { revisionNote: note }
    );
    if (!updated) {
      await sendTelegramText("対象はすでに処理済みです", message.message_id);
      return;
    }
    const employee = await getEmployee(updated.employeeId, updated.orgId);
    await runApprovalResolveSideEffects({
      approval: updated,
      decision: "revision_requested",
      actorEmail: actor,
      employee,
    });
  } catch (error) {
    await auditTelegramError(approval, error, actor);
    await sendTelegramText("修正依頼の処理に失敗しました", message.message_id);
  }
}

export async function POST(req: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || "";
  if (!secret) {
    console.error(
      "telegram_webhook_secret_missing: TELEGRAM_WEBHOOK_SECRET is empty; callback_query cannot be accepted (buttons stay dead)"
    );
    return NextResponse.json(
      { ok: false, error: "telegram_webhook_not_configured" },
      { status: 503 }
    );
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const update = (await req.json().catch(() => ({}))) as TelegramUpdate;
  try {
    if (update.callback_query) await handleCallback(update);
    else if (update.message) await handleReply(update);
  } catch (error) {
    console.error("telegram_webhook_unhandled", error);
  }
  return NextResponse.json({ ok: true });
}
