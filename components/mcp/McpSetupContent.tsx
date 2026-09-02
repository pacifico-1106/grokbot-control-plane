import Link from "next/link";
import { CopyableValue } from "@/components/CopyableValue";
import {
  STAFFPASS_MCP_DOCS_PATH,
  STAFFPASS_MCP_SERVER_CARD,
  STAFFPASS_MCP_TOOL_NAMES,
  STAFFPASS_MCP_TRANSPORT,
  STAFFPASS_MCP_URL,
} from "@/lib/mcp/public";

const TOOL_BLURB: Record<(typeof STAFFPASS_MCP_TOOL_NAMES)[number], string> = {
  staffpass_whoami: "いまの AI社員",
  staffpass_invoke: "実行（目的と jobId が必要）",
  staffpass_get_approval_status: "承認待ちの確認",
  staffpass_health: "つながりの確認",
};

export function McpSetupContent({
  variant = "dashboard",
}: {
  variant?: "dashboard" | "public";
}) {
  const isPublic = variant === "public";

  return (
    <div className="space-y-4" id={isPublic ? undefined : "mcp"}>
      <section className="surface p-5 space-y-3">
        {isPublic ? null : (
          <h2 className="text-sm font-medium">Grok Bot とつなぐ（MCP）</h2>
        )}
        <p className="text-sm muted leading-relaxed">
          チャットに URL を貼るだけではつながりません。Grok Bot の Plugins /
          コネクタ（リモート MCP）に Staffpass を登録します。
          これは社員証 MCP です。管理MCP（/api/mcp/admin, gb_adm_）とは別口です。
        </p>
        <div>
          <p className="text-xs muted mb-1.5">
            MCP URL（{STAFFPASS_MCP_TRANSPORT}）
          </p>
          <CopyableValue value={STAFFPASS_MCP_URL} />
        </div>
        <p className="text-xs muted leading-relaxed">
          認証は{" "}
          <code className="text-[11px]">Authorization: Bearer gb_emp_…</code>
          。代替ヘッダ{" "}
          <code className="text-[11px]">x-staffpass-credential</code>
          。社員証は雇ったときに一度だけ表示されます。この画面には出しません。
          {!isPublic ? (
            <>
              {" "}
              <Link
                href="/app/employees"
                className="underline underline-offset-2"
              >
                社員詳細
              </Link>
              で確認・再発行。
            </>
          ) : (
            " ダッシュボードの社員詳細で確認・再発行。"
          )}
        </p>
      </section>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="surface p-5 space-y-2">
          <h3 className="text-sm font-medium">持ち込みGrok</h3>
          <p className="text-[11px] faint">今の Grok Bot に載せる</p>
          <p className="text-sm muted leading-relaxed">
            お客様ご自身が Grok Bot の Plugins に Staffpass MCP を追加し、社員証を
            Bearer として貼ります。
          </p>
        </section>
        <section className="surface p-5 space-y-2">
          <h3 className="text-sm font-medium">運用代行</h3>
          <p className="text-[11px] faint">おまかせ導入</p>
          <p className="text-sm muted leading-relaxed">
            TOKYO307 が雇った Grok Bot に Plugin を入れます。お客様は Staffpass
            の画面かメールで承認するだけです。
          </p>
        </section>
      </div>

      <section className="surface p-5 space-y-3">
        <h3 className="text-sm font-medium">使えるツール</h3>
        <ul className="space-y-1.5">
          {STAFFPASS_MCP_TOOL_NAMES.map((name) => (
            <li key={name} className="text-sm min-w-0">
              <code className="text-xs font-mono">{name}</code>
              <span className="text-xs muted ml-2">{TOOL_BLURB[name]}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs muted leading-relaxed">
          confirm / send / order は人が見てから。承認されるまで実行しません。
        </p>
        <p className="text-xs faint leading-relaxed">
          本線は MCP。つながらないときは Instructions と署名付き poll で
          Staffpass 経由に戻します。
        </p>
        {isPublic ? (
          <div className="pt-1 space-y-2">
            <p className="text-xs muted">server-card</p>
            <CopyableValue value={STAFFPASS_MCP_SERVER_CARD} />
          </div>
        ) : (
          <p className="text-xs muted leading-relaxed">
            公開の手順:{" "}
            <Link
              href={STAFFPASS_MCP_DOCS_PATH}
              className="underline underline-offset-2"
            >
              /docs/mcp
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
