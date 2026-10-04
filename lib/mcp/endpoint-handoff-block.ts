/**
 * MCP endpoint handoff — pure, secret-free block builder (no data / network imports).
 * Stateful parts (seen signal, not-connected watcher) live in ./endpoint-handoff.
 */
import { resolveAppOrigin } from "@/lib/app-url";

export const MCP_HANDOFF_SCHEMA = "staffpass.mcp_handoff.v1" as const;
export const MCP_ENDPOINT_PATH = "/api/mcp";

export type McpHandoffSurface = "slack" | "line" | "telegram" | "web" | "admin_proxy";
export type McpHandoffKind = "conversation" | "approval_resolved";
export type McpConnectionStatus = "seen" | "not_seen" | "not_connected_suspected" | "unknown";

const SURFACES: readonly McpHandoffSurface[] = ["slack", "line", "telegram", "web", "admin_proxy"];
export const SURFACE_LABEL_JA: Record<McpHandoffSurface, string> = {
  slack: "Slack",
  line: "LINE",
  telegram: "Telegram",
  web: "Web（ダッシュボード承認）",
  admin_proxy: "代理承認",
};

export type McpHandoff = {
  schema: typeof MCP_HANDOFF_SCHEMA;
  employeeId: string;
  mcp: {
    url: string;
    transport: "streamable_http";
    serverCardUrl: string;
    docsUrl: string;
    auth: {
      type: "bearer";
      header: "Authorization";
      format: string;
      alternateHeader: "x-staffpass-credential";
      credential: "employee_badge";
      included: false;
    };
  };
  connectivityCheck: {
    tool: "staffpass_whoami";
    fallbackTool: "staffpass_health";
    arguments: Record<string, never>;
    jsonRpc: { method: "tools/call"; params: { name: "staffpass_whoami"; arguments: Record<string, never> } };
    expect: { employeeId: string };
  };
  reply: { mcpTool: "staffpass_invoke"; gatewayTool: "comm.reply" };
  setupSteps: Array<{ id: "register_mcp_server" | "attach_badge" | "verify"; ja: string }>;
  ifNotConnectedJa: string;
  wake?: { surface: McpHandoffSurface; kind: McpHandoffKind; trigger: string };
  connection?: { status: McpConnectionStatus; lastSeenAt: string | null };
  /**
   * Set only after a previous wake was not followed by any MCP call (stage 1 of the
   * not-connected escalation). Tells the bot to connect + verify BEFORE anything else.
   */
  reconnectRequired?: true;
  reconnectPromptJa?: string;
};

type Env = Record<string, string | undefined>;

/** `${app origin}/api/mcp` — from config (resolveAppOrigin), never request headers. */
export function resolveMcpEndpointUrl(env: Env = process.env): string {
  return `${resolveAppOrigin(env)}${MCP_ENDPOINT_PATH}`;
}

export function isMcpHandoffSurface(value: unknown): value is McpHandoffSurface {
  return typeof value === "string" && (SURFACES as readonly string[]).includes(value);
}

/** Pure, secret-free block. Safe to embed in any outbound payload. */
export function buildMcpHandoff(input: {
  employeeId: string;
  wake?: McpHandoff["wake"];
  connection?: McpHandoff["connection"];
  /** Stage-1 reconnect prompt (previous wake had no MCP activity). */
  reconnectRequired?: boolean;
  env?: Env;
}): McpHandoff {
  const origin = resolveAppOrigin(input.env ?? process.env);
  const url = `${origin}${MCP_ENDPOINT_PATH}`;
  const employeeId = input.employeeId;
  const block: McpHandoff = {
    schema: MCP_HANDOFF_SCHEMA,
    employeeId,
    mcp: {
      url,
      transport: "streamable_http",
      serverCardUrl: `${origin}/.well-known/mcp/server-card.json`,
      docsUrl: `${origin}/docs/mcp`,
      auth: {
        type: "bearer",
        header: "Authorization",
        format: "Bearer gb_emp_…",
        alternateHeader: "x-staffpass-credential",
        credential: "employee_badge",
        included: false,
      },
    },
    connectivityCheck: {
      tool: "staffpass_whoami",
      fallbackTool: "staffpass_health",
      arguments: {},
      jsonRpc: { method: "tools/call", params: { name: "staffpass_whoami", arguments: {} } },
      expect: { employeeId },
    },
    reply: { mcpTool: "staffpass_invoke", gatewayTool: "comm.reply" },
    setupSteps: [
      {
        id: "register_mcp_server",
        ja: `AI エージェントの MCP サーバー（コネクタ）設定に Staffpass を追加し、URL に ${url} を指定する（transport: Streamable HTTP）。`,
      },
      {
        id: "attach_badge",
        ja: "認証ヘッダー Authorization: Bearer に、この AI 社員用に発行済みの社員証（gb_emp_…）を設定する。社員証はこの情報には含まれない。チャットに貼らない。",
      },
      {
        id: "verify",
        ja: `staffpass_whoami を引数なしで呼び、employeeId=${employeeId} が返れば接続完了。失敗したら staffpass_health で状態を確認する。`,
      },
    ],
    ifNotConnectedJa: `staffpass_whoami を呼べない場合は Staffpass MCP に未接続です（comm.reply も呼べません）。管理者に「AI エージェントの MCP サーバー（コネクタ）設定に ${url} を登録し、発行済みの社員証を Authorization: Bearer に設定してください」と伝えてください。`,
  };
  if (input.wake) block.wake = input.wake;
  if (input.connection) block.connection = input.connection;
  if (input.reconnectRequired) {
    block.reconnectRequired = true;
    block.reconnectPromptJa = buildReconnectPromptJa(url, employeeId);
  }
  return block;
}

/**
 * Stronger "do this first" prompt for the bot. Secret-free. Addressed to the bot only —
 * it must not tell the person on the other end of the conversation (木村 decision 1).
 */
export function buildReconnectPromptJa(url: string, employeeId: string): string {
  return [
    "【最優先・接続の再確認】前回起こされた後、この社員証での Staffpass MCP 呼び出しが確認できていません。",
    `返信や他の作業より先に、MCP サーバー（コネクタ）設定に ${url} が登録され（Streamable HTTP）、発行済みの社員証が Authorization: Bearer に設定されているか確認し、`,
    `staffpass_whoami を引数なしで呼んで employeeId=${employeeId} が返ることを確かめてください。`,
    "この件は会話の相手には伝えないでください。",
  ].join("");
}

/** Validate a stored block (admin fulfillment round trip). Malformed → undefined. */
export function parseMcpHandoff(raw: unknown): McpHandoff | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.schema !== MCP_HANDOFF_SCHEMA) return undefined;
  const mcp = rec.mcp as Record<string, unknown> | undefined;
  if (!mcp || typeof mcp !== "object" || typeof mcp.url !== "string") return undefined;
  if (typeof rec.employeeId !== "string") return undefined;
  const check = rec.connectivityCheck as Record<string, unknown> | undefined;
  if (!check || check.tool !== "staffpass_whoami") return undefined;
  return rec as unknown as McpHandoff;
}
