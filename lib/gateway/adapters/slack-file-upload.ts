/**
 * Slack file upload adapter for comm.reply / comm.send egress.
 *
 * Uses files.getUploadURLExternal + files.completeUploadExternal (v2 flow)
 * with org conversation adapter xoxb token. Binary never enters LLM context.
 *
 * Egress P0: internal only. Mixed / external audiences → fail-closed for file body.
 * thread_ts required (boss DM / internal threads only).
 *
 * Scope requirement: files:write on the Slack app (Public Distribution reinstall).
 * Document this for human approval — do not silently expand scopes.
 */

import { resolveOrgSlackBotToken } from "@/lib/slack/bot-token";
import type { Audience } from "@/lib/types";

const SLACK_TIMEOUT_MS = 30_000;

export interface SlackFileUploadInput {
  orgId: string;
  channel: string;
  threadTs: string;
  /** File reference: temp store path, signed URL, or gateway-held base64 key */
  fileRef: string;
  /** Raw file bytes (gateway-only, never in LLM context). Mutually exclusive with fileUrl. */
  fileBuffer?: Buffer;
  /** Signed URL to fetch file (alternative to fileBuffer). */
  fileUrl?: string;
  filename: string;
  mimeType?: string;
  title?: string;
  initialComment?: string;
}

export interface SlackFileUploadResult {
  ok: true;
  fileId: string;
  filename: string;
  bytes: number;
  channel: string;
  threadTs: string;
  ts?: string;
}

export interface SlackFileUploadError {
  ok: false;
  error: string;
  code: string;
}

export type SlackFileUploadOutcome = SlackFileUploadResult | SlackFileUploadError;

export interface FileAttachmentEgressInput {
  audience: Audience;
  effectiveAudience: "internal" | "external";
  threadTs?: string;
  channel?: string;
}

export interface FileAttachmentEgressVerdict {
  allowed: boolean;
  reason: string;
  messageJa: string;
}

/**
 * Egress control for file attachments.
 *
 * P0: internal only, thread required.
 * - unknown audience → deny (fail-closed, checked first)
 * - external / mixed effective audience → deny
 * - missing thread_ts → deny (boss DM / internal threads only)
 */
export function evaluateFileAttachmentEgress(
  input: FileAttachmentEgressInput
): FileAttachmentEgressVerdict {
  if (input.audience === "unknown") {
    return {
      allowed: false,
      reason: "file_attachment_unknown_audience_denied",
      messageJa: "宛先が未確認のためファイル添付は拒否しました。本文のみ送信できます。",
    };
  }

  if (input.effectiveAudience === "external") {
    return {
      allowed: false,
      reason: "file_attachment_external_denied",
      messageJa: "ファイル添付の社外送信は許可されていません。本文のみ送信できます。",
    };
  }

  if (!input.threadTs?.trim()) {
    return {
      allowed: false,
      reason: "file_attachment_thread_required",
      messageJa: "ファイル添付にはスレッド指定（thread_ts）が必要です。",
    };
  }

  return {
    allowed: true,
    reason: "file_attachment_internal_allow",
    messageJa: "社内スレッドへのファイル添付を許可します。",
  };
}

/**
 * Slack files.getUploadURLExternal API call.
 */
async function getUploadUrl(
  token: string,
  filename: string,
  length: number
): Promise<
  | { ok: true; uploadUrl: string; fileId: string }
  | { ok: false; error: string }
> {
  try {
    const response = await fetch(
      "https://slack.com/api/files.getUploadURLExternal",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          filename,
          length: String(length),
        }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      }
    );
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!body.ok || !body.upload_url || !body.file_id) {
      return { ok: false, error: body.error || "get_upload_url_failed" };
    }
    return { ok: true, uploadUrl: body.upload_url, fileId: body.file_id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "get_upload_url_failed",
    };
  }
}

/**
 * Upload file bytes to Slack-provided URL.
 */
async function uploadToSlackUrl(
  uploadUrl: string,
  fileBuffer: Buffer,
  mimeType: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": mimeType,
      },
      body: new Uint8Array(fileBuffer),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `upload_http_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "upload_failed",
    };
  }
}

/**
 * Slack files.completeUploadExternal API call.
 */
async function completeUpload(
  token: string,
  fileId: string,
  channel: string,
  threadTs: string,
  title?: string,
  initialComment?: string
): Promise<
  | { ok: true; ts?: string }
  | { ok: false; error: string }
> {
  try {
    const files = [{ id: fileId, title: title || undefined }];
    const response = await fetch(
      "https://slack.com/api/files.completeUploadExternal",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          files,
          channel_id: channel,
          thread_ts: threadTs,
          initial_comment: initialComment || undefined,
        }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      }
    );
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      files?: Array<{ id?: string; timestamp?: string }>;
    };
    if (!body.ok) {
      return { ok: false, error: body.error || "complete_upload_failed" };
    }
    return { ok: true, ts: body.files?.[0]?.timestamp };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "complete_upload_failed",
    };
  }
}

/**
 * Fetch file from signed URL (alternative to direct buffer).
 */
async function fetchFileFromUrl(
  fileUrl: string
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: string }> {
  try {
    const response = await fetch(fileUrl, {
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `fetch_file_http_${response.status}` };
    }
    const arrayBuffer = await response.arrayBuffer();
    return { ok: true, buffer: Buffer.from(arrayBuffer) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "fetch_file_failed",
    };
  }
}

/**
 * Upload file to Slack channel/thread using files.uploadV2 flow.
 *
 * Requires:
 * - org conversation adapter with xoxb token
 * - files:write scope on Slack app
 * - thread_ts (boss DM / internal threads only)
 *
 * Binary file data is passed via fileBuffer (gateway-held) or fileUrl (signed URL).
 * Never passes through LLM context.
 */
export async function uploadSlackFile(
  input: SlackFileUploadInput
): Promise<SlackFileUploadOutcome> {
  const token = await resolveOrgSlackBotToken(input.orgId);
  if (!token) {
    return {
      ok: false,
      error: "slack_bot_token_missing",
      code: "slack_bot_token_missing",
    };
  }

  if (!input.channel?.trim()) {
    return {
      ok: false,
      error: "channel_required",
      code: "channel_required",
    };
  }

  if (!input.threadTs?.trim()) {
    return {
      ok: false,
      error: "thread_ts_required",
      code: "thread_ts_required",
    };
  }

  if (!input.filename?.trim()) {
    return {
      ok: false,
      error: "filename_required",
      code: "filename_required",
    };
  }

  let fileBuffer: Buffer;
  if (input.fileBuffer) {
    fileBuffer = input.fileBuffer;
  } else if (input.fileUrl) {
    const fetchResult = await fetchFileFromUrl(input.fileUrl);
    if (!fetchResult.ok) {
      return {
        ok: false,
        error: fetchResult.error,
        code: "file_fetch_failed",
      };
    }
    fileBuffer = fetchResult.buffer;
  } else {
    return {
      ok: false,
      error: "file_source_required",
      code: "file_source_required",
    };
  }

  const mimeType = input.mimeType || "application/octet-stream";

  const uploadUrlResult = await getUploadUrl(
    token,
    input.filename,
    fileBuffer.length
  );
  if (!uploadUrlResult.ok) {
    return {
      ok: false,
      error: uploadUrlResult.error,
      code: "get_upload_url_failed",
    };
  }

  const uploadResult = await uploadToSlackUrl(
    uploadUrlResult.uploadUrl,
    fileBuffer,
    mimeType
  );
  if (!uploadResult.ok) {
    return {
      ok: false,
      error: uploadResult.error,
      code: "file_upload_failed",
    };
  }

  const completeResult = await completeUpload(
    token,
    uploadUrlResult.fileId,
    input.channel,
    input.threadTs,
    input.title,
    input.initialComment
  );
  if (!completeResult.ok) {
    return {
      ok: false,
      error: completeResult.error,
      code: "complete_upload_failed",
    };
  }

  return {
    ok: true,
    fileId: uploadUrlResult.fileId,
    filename: input.filename,
    bytes: fileBuffer.length,
    channel: input.channel,
    threadTs: input.threadTs,
    ts: completeResult.ts,
  };
}

/**
 * Audit payload for file upload events.
 */
export interface SlackFileUploadAuditPayload {
  jobId: string;
  channel: string;
  threadTs: string;
  fileId: string;
  filename: string;
  bytes: number;
  audience: Audience;
  mimeType?: string;
  fileRef?: string;
}

/**
 * Build audit payload from upload result.
 */
export function buildFileUploadAuditPayload(
  result: SlackFileUploadResult,
  extra: {
    jobId: string;
    audience: Audience;
    mimeType?: string;
    fileRef?: string;
  }
): Record<string, unknown> {
  return {
    jobId: extra.jobId,
    channel: result.channel,
    threadTs: result.threadTs,
    fileId: result.fileId,
    filename: result.filename,
    bytes: result.bytes,
    audience: extra.audience,
    mimeType: extra.mimeType,
    fileRef: extra.fileRef,
  };
}
