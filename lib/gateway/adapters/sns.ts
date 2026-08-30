/**
 * Personal SNS posting adapter (sns.publish).
 * Official APIs first. Browser automation is last-resort and not in this slice.
 * Missing credentials → Japanese error (ticket stays approved). Do not invent tokens.
 *
 * Env stubs (do not invent live values):
 *   X_USER_ACCESS_TOKEN / X_BEARER_TOKEN / SNS_X_BEARER_TOKEN
 *   NOTE_API_TOKEN / SNS_NOTE_ACCESS_TOKEN
 *   LINKEDIN_ACCESS_TOKEN / LINKEDIN_AUTHOR_URN / SNS_LINKEDIN_ACCESS_TOKEN
 *   YOUTUBE_ACCESS_TOKEN / SNS_YOUTUBE_ACCESS_TOKEN
 * Org table: org_sns_adapters / org_sns_adapter_secrets.
 */

export const SNS_SURFACES = ["x", "note", "linkedin", "youtube"] as const;
export type SnsSurface = (typeof SNS_SURFACES)[number];

export const SNS_SURFACE_LABELS: Record<SnsSurface, string> = {
  x: "X",
  note: "note",
  linkedin: "LinkedIn",
  youtube: "YouTube",
};

const SNS_TIMEOUT_MS = 8_000;

export type SnsPublishInput = {
  orgId?: string;
  employeeId?: string;
  surface?: unknown;
  text?: string;
  scheduledAt?: unknown;
  title?: unknown;
};

export type SnsPublishResult =
  | { ok: true; delivery: "stub" | "sns"; surface: SnsSurface; id?: string }
  | { ok: false; error: string; surface?: SnsSurface };

export function parseSnsSurface(raw: unknown): SnsSurface | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "twitter") return "x";
  if ((SNS_SURFACES as readonly string[]).includes(value)) return value as SnsSurface;
  return null;
}

export function snsSurfaceLabelJa(surface: string): string {
  const parsed = parseSnsSurface(surface);
  return parsed ? SNS_SURFACE_LABELS[parsed] : surface;
}

export const snsSurfaceLabel = snsSurfaceLabelJa;

function envKeysFor(surface: SnsSurface): string[] {
  switch (surface) {
    case "x":
      return ["X_USER_ACCESS_TOKEN", "X_BEARER_TOKEN", "SNS_X_BEARER_TOKEN", "SNS_X_ACCESS_TOKEN"];
    case "note":
      return ["NOTE_API_TOKEN", "SNS_NOTE_ACCESS_TOKEN"];
    case "linkedin":
      return ["LINKEDIN_ACCESS_TOKEN", "SNS_LINKEDIN_ACCESS_TOKEN"];
    case "youtube":
      return ["YOUTUBE_ACCESS_TOKEN", "SNS_YOUTUBE_ACCESS_TOKEN"];
  }
}

function envTokenFor(surface: SnsSurface): string {
  for (const key of envKeysFor(surface)) {
    const value = process.env[key]?.trim() || "";
    if (value) return value;
  }
  return "";
}

export function snsCredentialsPresent(surface: SnsSurface): boolean {
  return Boolean(envTokenFor(surface));
}

function missingCredentialError(surface: SnsSurface): string {
  return `${SNS_SURFACE_LABELS[surface]} の投稿用認証情報が未設定です。組織の SNS アダプタまたは環境変数を設定してください。`;
}

function unimplementedOfficialApiError(surface: SnsSurface): string {
  return `${SNS_SURFACE_LABELS[surface]} の公式投稿APIは未配線です。ブラウザ投稿は後続です。`;
}

async function loadAdapterSecrets(
  orgId: string | undefined,
  surface: SnsSurface
): Promise<Record<string, string>> {
  if (!orgId) return {};
  try {
    const { getEnabledSnsAdapter } = await import("@/lib/data/sns-adapters");
    const adapter = await getEnabledSnsAdapter(orgId, surface);
    return adapter?.secrets ?? {};
  } catch {
    return {};
  }
}

function tokenFromSecrets(secrets: Record<string, string>): string {
  return (
    secrets.bearerToken?.trim() ||
    secrets.accessToken?.trim() ||
    secrets.token?.trim() ||
    secrets.userAccessToken?.trim() ||
    ""
  );
}

function isFutureScheduled(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > Date.now() + 30_000;
}

function scheduledUnsupportedError(surface: SnsSurface): string {
  return `${SNS_SURFACE_LABELS[surface]} の予約投稿（公開予定）は公式API未配線です。本文は投稿していません。`;
}

function stubEnabled(secrets: Record<string, string>): boolean {
  return (
    process.env.SNS_PUBLISH_STUB?.trim() === "1" ||
    secrets.stub === "1" ||
    secrets.stub === "true"
  );
}

async function postToX(token: string, text: string): Promise<SnsPublishResult> {
  try {
    const response = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SNS_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: { id?: string };
      errors?: Array<{ message?: string; detail?: string }>;
      title?: string;
      detail?: string;
    };
    if (!response.ok) {
      const apiError =
        body.errors?.[0]?.message ||
        body.errors?.[0]?.detail ||
        body.detail ||
        body.title ||
        `http_${response.status}`;
      return {
        ok: false,
        error: `X への投稿に失敗しました（${apiError}）`,
        surface: "x",
      };
    }
    return {
      ok: true,
      delivery: "sns",
      surface: "x",
      id: typeof body.data?.id === "string" ? body.data.id : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `X への投稿に失敗しました（${error.message}）`
          : "X への投稿に失敗しました",
      surface: "x",
    };
  }
}

/**
 * Post after human approval (or auto when the operator loosened the hint).
 * Never throws. Missing credentials are a Japanese error.
 */
export async function publishSnsPost(input: SnsPublishInput): Promise<SnsPublishResult> {
  const surface = parseSnsSurface(input.surface);
  if (!surface) {
    return {
      ok: false,
      error: "媒体が指定されていません。x / note / linkedin / youtube のいずれかを指定してください。",
    };
  }
  const text = (input.text || "").trim();
  if (!text) {
    return { ok: false, error: "投稿本文が空です。", surface };
  }

  const secrets = await loadAdapterSecrets(input.orgId, surface);
  if (stubEnabled(secrets)) {
    return { ok: true, delivery: "stub", surface };
  }

  const token = tokenFromSecrets(secrets) || envTokenFor(surface);
  if (!token) {
    return { ok: false, error: missingCredentialError(surface), surface };
  }

  if (isFutureScheduled(input.scheduledAt)) {
    return { ok: false, error: scheduledUnsupportedError(surface), surface };
  }

  if (surface === "x") {
    return postToX(token, text);
  }

  return { ok: false, error: unimplementedOfficialApiError(surface), surface };
}

export const postSnsMessage = publishSnsPost;
