import { NextResponse } from "next/server";
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
  if (!isExpectedChat(query.message) || !isAllowedUser(query.from)) {
    await answerTelegramCallback(query.id || "", "この操作は許可されていません");
    return;
  }

  const match = /^(a|r|e):([A-Za-z0-9_-]{8,32})$/.exec(query.data || "");
  if (!match) {
    await answerTelegramCallback(query.id || "", "無効な操作です");
    return;
  }

  const approval = await getApprovalByTelegramRef(match[2]);
  try {
    if (
      !approval ||
      !(await shouldUseGlobalTelegramFallback(approval.orgId)) ||
      approval.status !== "pending" ||
      approval.telegramMessageId !== query.message?.message_id
    ) {
      await answerTelegramCallback(query.id || "", "対象は処理済みか見つかりません");
      return;
    }

    if (match[1] === "e") {
      const prompted = await promptTelegramRevision(approval, query.from!.id!);
      await answerTelegramCallback(
        query.id || "",
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
      await answerTelegramCallback(query.id || "", "対象はすでに処理済みです");
      return;
    }
    const employee = await getEmployee(updated.employeeId, updated.orgId);
    await runApprovalResolveSideEffects({
      approval: updated,
      decision,
      actorEmail: actor,
      employee,
    });
    await answerTelegramCallback(
      query.id || "",
      decision === "approved" ? "承認しました" : "却下しました"
    );
  } catch (error) {
    await auditTelegramError(approval, error, actor);
    await answerTelegramCallback(query.id || "", "処理に失敗しました");
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
