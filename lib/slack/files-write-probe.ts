/**
 * Safe read-only probe for Slack files:write scope via files.getUploadURLExternal.
 * Does not upload bytes — only checks whether the token can obtain an upload URL.
 */

export type FilesWriteProbeResult = {
  ready: boolean;
  code: string;
  needed?: string;
};

const PROBE_FILENAME = "_staffpass_probe.txt";
const PROBE_LENGTH = "1";
const DEFAULT_TIMEOUT_MS = 5_000;

export async function probeSlackFilesWrite(
  token: string | null | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<FilesWriteProbeResult> {
  const trimmed = (token || "").trim();
  if (!trimmed) {
    return { ready: false, code: "no_token" };
  }
  try {
    const response = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${trimmed}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: PROBE_FILENAME,
        length: PROBE_LENGTH,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      needed?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (body.ok && body.upload_url && body.file_id) {
      return { ready: true, code: "ok" };
    }
    if (body.error === "missing_scope") {
      return {
        ready: false,
        code: "missing_scope",
        needed: body.needed || "files:write",
      };
    }
    return { ready: false, code: body.error || "probe_failed" };
  } catch (error) {
    return {
      ready: false,
      code: error instanceof Error ? error.message : "probe_error",
    };
  }
}
