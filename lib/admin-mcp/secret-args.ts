/**
 * H5 (LINE / LINE WORKS design 10/12 §6; 八坂さん decision 3): tenants enter
 * secrets themselves, on a screen. A secret never passes through the AI, so no
 * MCP tool takes one as an argument.
 *
 * The admin MCP tools that used to (setup.lineApproval.upsert,
 * setup.slackAdapter.setBotToken) refuse the argument here, before anything
 * else runs: nothing is queued, stored, logged or audited, and the answer
 * carries only the argument NAMES — never a value, a prefix, a length or a
 * hash of it. Values already stored are not touched.
 */

export const SECRET_ARGUMENT_REFUSED = "secret_argument_refused";
export const SETTINGS_SCREEN_PATH = "/app/settings";

export type SecretArgScreen = { path: string; labelJa: string };

export const LINE_APPROVAL_SCREEN: SecretArgScreen = {
  path: SETTINGS_SCREEN_PATH,
  labelJa: "つながり →「承認を受け取る」を追加 → 承認用LINE（チャネルアクセストークンとチャネルシークレット）",
};
export const SLACK_BOT_TOKEN_SCREEN: SecretArgScreen = {
  path: SETTINGS_SCREEN_PATH,
  labelJa: "つながり →「チャンネルに書き込む（会社のBot）」の Bot token 欄",
};

/** Tool → its retired secret arguments and the screen where the tenant enters them. */
export const ADMIN_MCP_SECRET_ARGS: Readonly<Record<string, { args: readonly string[]; screen: SecretArgScreen }>> = {
  "setup.lineApproval.upsert": { args: ["channelAccessToken", "channelSecret"], screen: LINE_APPROVAL_SCREEN },
  "setup.slackAdapter.setBotToken": { args: ["botToken"], screen: SLACK_BOT_TOKEN_SCREEN },
};

export function screenNextStepJa(screen: SecretArgScreen): string {
  return `秘密の値（トークン・シークレット）は、AI に渡さず、テナントの担当者が画面で入力します。管理画面 ${screen.path} の「${screen.labelJa}」で入力してもらってください。値をチャットに貼らないでください。入力が済んだら、秘密の値を付けずにもう一度このツールを呼べます（秘密以外の項目だけ変更できます）。`;
}

export type SecretArgRefusal = {
  ok: false;
  code: typeof SECRET_ARGUMENT_REFUSED;
  error: typeof SECRET_ARGUMENT_REFUSED;
  tool: string;
  refusedArgs: string[];
  message: string;
  nextAction: "use_dashboard";
  nextStep: string;
  screen: SecretArgScreen;
};

/** Present = any value other than undefined / null (an empty string is refused too: the arg is retired). */
function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** "BotToken", "bot_token", "bot-token", "BOTTOKEN" → "bottoken". */
export function normalizeArgName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * #352 follow-up: a key NAME that looks like it carries a secret, whatever its
 * case or separators. The retired names themselves, plus the generic words, so a
 * renamed key (ChannelSecret, secrets.channelSecret, config.auth.bot_token …) is
 * refused instead of being queued with its value dropped.
 */
const SECRET_NAME_WORDS = [
  "token", "secret", "password", "passwd", "passphrase", "apikey", "privatekey", "credential",
  "signingkey", "accesskey", "webhook", "bearer", "authorization", "cookie", "xoxb", "xoxp",
];
export function isSecretShapedArgName(name: string): boolean {
  const n = normalizeArgName(name);
  return n.length > 0 && SECRET_NAME_WORDS.some((word) => n.includes(word));
}

const MAX_SCAN_DEPTH = 6;

/** Paths (names only) of every secret-shaped key, nested keys included. A container whose
 *  children are flagged is reported through them (secrets.channelSecret, not secrets). */
function secretArgPaths(value: unknown, prefix: string, depth: number, out: string[]): boolean {
  if (depth > MAX_SCAN_DEPTH || value === null || typeof value !== "object") return false;
  let found = false;
  const entries: Array<[string, unknown, string]> = Array.isArray(value)
    ? value.slice(0, 200).map((item, i) => [String(i), item, `${prefix}[${i}]`])
    : Object.keys(value as Record<string, unknown>).slice(0, 200).map((key) => [key, (value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key]);
  for (const [key, child, path] of entries) {
    const childFound = secretArgPaths(child, path, depth + 1, out);
    if (childFound) {
      found = true;
      continue;
    }
    if (!Array.isArray(value) && isSecretShapedArgName(key) && present(child)) {
      out.push(path);
      found = true;
    }
  }
  return found;
}

/** null when the call carries no secret-shaped argument. Never reads more than the key names. */
export function refuseSecretArgs(tool: string, args: Record<string, unknown>): SecretArgRefusal | null {
  const entry = ADMIN_MCP_SECRET_ARGS[tool];
  if (!entry) return null;
  const refusedArgs: string[] = [];
  secretArgPaths(args, "", 0, refusedArgs);
  if (refusedArgs.length === 0) return null;
  return {
    ok: false,
    code: SECRET_ARGUMENT_REFUSED,
    error: SECRET_ARGUMENT_REFUSED,
    tool,
    refusedArgs,
    message: `${refusedArgs.join(" / ")} は受け付けません（秘密の値は AI を通さず、画面で入力します）。何も保存・登録していません。保存済みの値はそのままです。`,
    nextAction: "use_dashboard",
    nextStep: screenNextStepJa(entry.screen),
    screen: entry.screen,
  };
}

export const UNKNOWN_ARGUMENT_REFUSED = "unknown_argument_refused";

export type UnknownArgRefusal = {
  ok: false;
  code: typeof UNKNOWN_ARGUMENT_REFUSED;
  error: typeof UNKNOWN_ARGUMENT_REFUSED;
  tool: string;
  unknownArgs: string[];
  allowedArgs: string[];
  message: string;
  nextStep: string;
};

/**
 * #352 follow-up (allowlist): on the tools that used to take a secret, any key
 * outside the tool's schema is refused (names only, never values) instead of
 * being silently dropped while the rest is queued.
 */
export function refuseUnknownArgs(tool: string, args: Record<string, unknown>, allowedArgs: readonly string[]): UnknownArgRefusal | null {
  if (!ADMIN_MCP_SECRET_ARGS[tool]) return null;
  const allowed = new Set([...allowedArgs, "approvalId"]);
  const unknownArgs = Object.keys(args).filter((key) => !allowed.has(key)).slice(0, 20);
  if (unknownArgs.length === 0) return null;
  const allowedList = [...allowed].sort();
  return {
    ok: false,
    code: UNKNOWN_ARGUMENT_REFUSED,
    error: UNKNOWN_ARGUMENT_REFUSED,
    tool,
    unknownArgs,
    allowedArgs: allowedList,
    message: `${unknownArgs.join(" / ")} はこのツールの引数ではありません。何も登録していません。`,
    nextStep: `使える引数は ${allowedList.join(", ")} だけです。秘密の値（トークン・シークレット）は引数に入れず、管理画面 ${SETTINGS_SCREEN_PATH} でテナントの担当者が入力します。`,
  };
}

export const INVALID_LABEL = "invalid_label";
export const LABEL_MAX_CHARS = 60;

export type InvalidLabelRefusal = {
  ok: false;
  code: typeof INVALID_LABEL;
  error: typeof INVALID_LABEL;
  tool: string;
  reason: "not_a_string" | "too_long" | "control_characters" | "long_hex_run" | "long_base64_run" | "secret_detected";
  message: string;
  nextStep: string;
};

/**
 * #352 follow-up: a display label is short human text. A LINE channel secret
 * (32 hex) or any token pasted into it used to reach the queue, because the
 * label is free text the secret detector did not flag. Limits: ≤ 60 chars, no
 * control characters, no hex run ≥ 16, no base64/token-like run ≥ 20 that mixes
 * letters and digits, and nothing the secret detector flags. Never echoes the value.
 */
export function refuseInvalidLabel(
  tool: string,
  args: Record<string, unknown>,
  detect: (payload: unknown) => { ok: boolean; suspected?: unknown[] }
): InvalidLabelRefusal | null {
  if (!ADMIN_MCP_SECRET_ARGS[tool] || !present(args.label)) return null;
  const refuse = (reason: InvalidLabelRefusal["reason"]): InvalidLabelRefusal => ({
    ok: false,
    code: INVALID_LABEL,
    error: INVALID_LABEL,
    tool,
    reason,
    message: "label を受け付けません（表示名は 60 文字以内の短い文字列です。トークンやシークレットのような値は入れられません）。何も登録していません。",
    nextStep: `label は「承認用LINE（本社）」のような短い表示名にしてください（${LABEL_MAX_CHARS} 文字以内）。秘密の値は管理画面 ${SETTINGS_SCREEN_PATH} でテナントの担当者が入力します。`,
  });
  const label = args.label;
  if (typeof label !== "string") return refuse("not_a_string");
  if ([...label].length > LABEL_MAX_CHARS) return refuse("too_long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(label)) return refuse("control_characters");
  if (/[0-9a-fA-F]{16,}/.test(label)) return refuse("long_hex_run");
  for (const run of label.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) {
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run)) return refuse("long_base64_run");
  }
  const detection = detect({ label });
  if (!detection.ok || (detection.suspected?.length ?? 0) > 0) return refuse("secret_detected");
  return null;
}
