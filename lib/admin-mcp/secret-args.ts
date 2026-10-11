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

export function useScreenNextStepJa(screen: SecretArgScreen): string {
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

/** null when the call carries no retired secret argument. Never reads more than the key names. */
export function refuseSecretArgs(tool: string, args: Record<string, unknown>): SecretArgRefusal | null {
  const entry = ADMIN_MCP_SECRET_ARGS[tool];
  if (!entry) return null;
  const refusedArgs = entry.args.filter((name) => Object.prototype.hasOwnProperty.call(args, name) && present(args[name]));
  if (refusedArgs.length === 0) return null;
  return {
    ok: false,
    code: SECRET_ARGUMENT_REFUSED,
    error: SECRET_ARGUMENT_REFUSED,
    tool,
    refusedArgs,
    message: `${refusedArgs.join(" / ")} は受け付けません（秘密の値は AI を通さず、画面で入力します）。何も保存・登録していません。保存済みの値はそのままです。`,
    nextAction: "use_dashboard",
    nextStep: useScreenNextStepJa(entry.screen),
    screen: entry.screen,
  };
}
