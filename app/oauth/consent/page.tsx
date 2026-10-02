import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { isMcpOAuthEnabled } from "@/lib/mcp-oauth/config";
import { defaultConsentDeps, loadConsentView, type ConsentView } from "@/lib/mcp-oauth/consent";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI クライアント接続の許可 | Staffpass", robots: { index: false, follow: false } };

const BLOCKED_TEXT: Record<NonNullable<ConsentView["blockedReason"]>, string> = {
  role: "接続を許可できるのは、社員証の発行権限（hire_issue_credentials）を持つオーナーまたは管理者だけです。拒否のみ選べます。",
  org_not_allowed: "この組織では AI クライアント接続（OAuth）はまだ有効になっていません。",
  login_too_old: "安全のため、許可の前に再ログインが必要です（最後のログインから 15 分以内）。",
  mfa_required: "許可の前に二要素認証を済ませてください。",
  no_employees: "接続できる AI 社員がいません。先に社員証を発行してください。",
};

function LogoutButton({ rid, label }: { rid: string; label: string }) {
  return (
    <form action="/api/auth/logout" method="post" className="inline">
      <input type="hidden" name="next" value={`/oauth/consent?rid=${rid}`} />
      <button type="submit" className="underline text-sm">
        {label}
      </button>
    </form>
  );
}

export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<{ rid?: string }> }) {
  if (!isMcpOAuthEnabled()) notFound();
  const sp = await searchParams;
  const rid = typeof sp.rid === "string" ? sp.rid : "";
  const out = await loadConsentView(rid, await defaultConsentDeps());

  if (out.type === "login_required") {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?rid=${rid}`)}`);
  }

  if (out.type === "page") {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-lg surface p-6">
          <BrandMark size="md" href="/" />
          <h1 className="mt-4 text-xl font-bold">接続を続けられません</h1>
          <p className="mt-3 text-sm">{out.messageJa}</p>
          <p className="mt-2 text-xs faint">error: {out.error}</p>
        </div>
      </main>
    );
  }

  const v = out.view;
  const canAllow = v.blockedReason === null;
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl surface p-6 md:p-8">
        <BrandMark size="md" href="/" />
        <p className="mt-5 text-xs faint">Staffpass</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">AI クライアントに AI 社員の社員証を貸し出す</h1>

        <section className="mt-6">
          <h2 className="text-sm font-semibold">接続を求めているクライアント</h2>
          <p className="mt-1 text-lg">
            {v.client.name}{" "}
            {v.client.verifiedHost ? (
              <span className="ml-1 rounded px-2 py-0.5 text-xs border">確認済みホスト</span>
            ) : (
              <span className="ml-1 rounded px-2 py-0.5 text-xs border">未検証</span>
            )}
          </p>
          <p className="mt-1 text-3xl font-bold tracking-tight">{v.client.redirectHost}</p>
          {v.client.loopback ? (
            <p className="mt-2 text-sm font-semibold">
              ⚠ この接続はあなたの PC 上のアプリに渡されます。自分で始めた操作でなければ拒否してください。
            </p>
          ) : null}
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-semibold">接続先の組織</h2>
          <p className="mt-1">
            <strong>{v.orgName}</strong>（{v.email} でログイン中）
          </p>
          <p className="mt-1 text-sm muted">
            この組織ではありませんか？ <LogoutButton rid={v.rid} label="ログアウトして切り替える" />
          </p>
        </section>

        {v.blockedReason ? (
          <p className="mt-6 rounded border p-3 text-sm" role="alert">
            {BLOCKED_TEXT[v.blockedReason]}{" "}
            {v.blockedReason === "login_too_old" ? <LogoutButton rid={v.rid} label="再ログインする" /> : null}
          </p>
        ) : null}

        <form action="/api/oauth/consent" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="rid" value={v.rid} />
          <input type="hidden" name="csrf" value={v.csrf} />

          {v.employees.length > 0 ? (
            <fieldset disabled={!canAllow} className="space-y-3">
              <legend className="text-sm font-semibold">接続する AI 社員</legend>
              {v.employees.map((e, i) => (
                <label key={e.id} className="block rounded border p-3">
                  <input type="radio" name="employee_id" value={e.id} defaultChecked={i === 0} required className="mr-2" />
                  <strong>{e.displayName}</strong> <span className="muted text-sm">{e.roleLabel}</span>
                  <dl className="mt-2 text-xs muted grid grid-cols-[8rem_1fr] gap-x-2 gap-y-1">
                    <dt>権限（scopes）</dt>
                    <dd>{e.scopes.length ? e.scopes.join(", ") : "なし"}</dd>
                    <dt>許可された目的</dt>
                    <dd>{e.allowedPurposes.length ? e.allowedPurposes.join(", ") : "なし"}</dd>
                    <dt>社員証の有効期限</dt>
                    <dd>{e.credentialExpiresAt ? new Date(e.credentialExpiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "無期限"}</dd>
                  </dl>
                </label>
              ))}
            </fieldset>
          ) : null}

          <p className="text-sm">
            この AI クライアントは<strong>選んだ社員証と同じ権限</strong>で動きます。送信・確定・発注は今まで通り人の承認が必要です。
            このリンクを自分で開始した場合だけ許可してください。許可は社員詳細画面からいつでも取り消せます。
          </p>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="confirm" value="yes" disabled={!canAllow} required={canAllow} />
            <span>内容を確認しました。この AI クライアントに上記の AI 社員として行動させることを許可します。</span>
          </label>

          <div className="flex gap-3">
            <button type="submit" name="decision" value="allow" disabled={!canAllow} className="btn-primary px-4 py-2 rounded">
              許可する
            </button>
            <button type="submit" name="decision" value="deny" formNoValidate className="px-4 py-2 rounded border">
              拒否
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
