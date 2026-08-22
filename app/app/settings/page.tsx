import { AppShell } from "@/components/AppShell";
import { DEMO_ORG } from "@/lib/demo-data";

export default function SettingsPage() {
  return (
    <AppShell
      title="連携設定"
      subtitle="Managed（こちらで用意）または BYO Grok Bot"
    >
      <div className="grid lg:grid-cols-2 gap-4">
        <section className="surface p-5">
          <h2 className="text-sm font-medium">導入モード</h2>
          <p className="mt-2 text-sm muted leading-relaxed">
            現在: <strong className="text-[var(--text)]">{DEMO_ORG.integrationMode}</strong>
          </p>
          <div className="mt-4 space-y-3">
            <label className="flex gap-3 rounded-lg border border-[var(--border)] p-3 cursor-pointer">
              <input type="radio" name="mode" defaultChecked className="mt-1" />
              <div>
                <div className="text-sm">Managed</div>
                <p className="text-xs muted mt-1">
                  弊社が Grok Bot をセットアップし、制御面に接続済みでお渡しします。
                </p>
              </div>
            </label>
            <label className="flex gap-3 rounded-lg border border-[var(--border)] p-3 cursor-pointer">
              <input type="radio" name="mode" className="mt-1" />
              <div>
                <div className="text-sm">BYO Grok Bot</div>
                <p className="text-xs muted mt-1">
                  既存ワークスペースの接続トークンを登録。ゲートと監査のみ利用します。
                </p>
              </div>
            </label>
          </div>
          <button type="button" className="btn btn-primary mt-5 text-sm">
            保存（スタブ）
          </button>
        </section>

        <section className="surface p-5">
          <h2 className="text-sm font-medium">接続情報（スタブ）</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="text-xs muted">Org ID</dt>
              <dd className="font-mono text-xs mt-1">{DEMO_ORG.id}</dd>
            </div>
            <div>
              <dt className="text-xs muted">Gateway endpoint</dt>
              <dd className="font-mono text-xs mt-1">
                https://control.example.com/v1/gateway
              </dd>
            </div>
            <div>
              <dt className="text-xs muted">共有ホスト注記</dt>
              <dd className="muted text-xs mt-1 leading-relaxed">
                Grok Bot の実行環境は共有です。職務分離は社員証・承認・監査で担保します。
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </AppShell>
  );
}
