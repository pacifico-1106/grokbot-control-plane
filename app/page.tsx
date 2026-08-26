import Link from "next/link";
import Image from "next/image";
import { BrandMark } from "@/components/BrandMark";
import { EmployeeAvatar } from "@/components/employees/EmployeeAvatar";
import { LegalLinks } from "@/components/LegalLinks";

const CONTROLS = [
  { icon: "01", title: "権限を分ける", body: "社員ごとに職務と操作範囲を限定。まとめる場合は全件承認に切り替えます。" },
  { icon: "02", title: "人が止める", body: "送信・確定・発注など、戻せない操作は承認されるまで実行しません。" },
  { icon: "03", title: "記録を残す", body: "目的、承認者、実行結果を一つの監査台帳に残します。" },
];

const AGENTS = [
  { name: "Grok Bot", status: "対応中", active: true },
  { name: "ChatGPT", status: "順次対応" },
  { name: "Claude", status: "順次対応" },
  { name: "その他のAI", status: "続々対応予定" },
];

function ControlVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[560px] pt-20 sm:pt-16" aria-label="Pebble Crewの社員証と、AI社員の実行をStaffpassが制御する図">
      <div className="absolute -inset-10 bg-[radial-gradient(circle,var(--accent-glow),transparent_64%)] blur-2xl" />
      <div className="hero-crew absolute right-4 top-0 z-10 flex items-end gap-2 sm:right-8">
        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[color-mix(in_oklab,var(--bg-elevated)_92%,transparent)] px-3 py-2 shadow-xl backdrop-blur-md">
          <span className="block font-mono text-[8px] tracking-[0.14em] text-[var(--accent-strong)]">PEBBLE CREW</span>
          <span className="mt-0.5 block text-[10px] muted">READY TO WORK</span>
        </div>
        <div className="crew-character relative h-[112px] w-[112px] sm:h-[132px] sm:w-[132px]">
          <Image
            src="/brand/ai-employee-pebble-core.png"
            alt="StaffpassのオリジナルAIクルーキャラクター"
            width={132}
            height={132}
            priority
            className="h-full w-full object-contain drop-shadow-[0_18px_30px_rgba(0,0,0,.55)]"
          />
          <span className="crew-eye crew-eye-left" aria-hidden="true" />
          <span className="crew-eye crew-eye-right" aria-hidden="true" />
        </div>
      </div>
      <div className="relative surface landing-console p-3 sm:p-4">
        <div className="flex items-center justify-between border-b border-[var(--border-soft)] pb-3">
          <div className="flex items-center gap-2"><span className="status-dot" /> <span className="text-xs muted">Control plane</span></div>
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
          <div className="visual-node visual-employee-pass">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="font-mono text-[7px] tracking-[0.12em] text-[var(--accent-strong)]">AI EMPLOYEE PASS</span>
                <strong className="mt-2 block text-xs sm:text-sm">営業AI社員</strong>
                <span className="mt-0.5 block text-[9px] faint">営業アシスタント</span>
              </div>
              <EmployeeAvatar seed="landing-sales-crew" size={46} />
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-2 font-mono text-[7px] faint">
              <span>EMPLOYEE ID</span><span>EMP_SALES</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-1 text-[var(--accent-strong)]">
            <span className="text-xs">→</span><span className="text-[9px] font-mono">GATE</span><span className="text-xs">→</span>
          </div>
          <div className="visual-node visual-node-accent">
            <span className="text-[10px] faint">Staffpass</span>
            <strong className="mt-1 block text-xs sm:text-sm">承認を待機</strong>
            <span className="mt-2 chip chip-warn text-[9px] sm:text-[10px]">人が確認</span>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[["権限","最小限"],["上限","20 / 日"],["監査","記録済み"]].map(([label, value]) => (
            <div key={label} className="metric-tile"><span>{label}</span><strong>{value}</strong></div>
          ))}
        </div>
        <div className="mt-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg)] p-3">
          <div className="flex justify-between text-[10px] muted"><span>権限集中度</span><span>33%</span></div>
          <div className="mt-2 h-1.5 rounded-full bg-[var(--border-soft)] overflow-hidden"><div className="h-full w-1/3 rounded-full bg-[var(--accent-strong)]" /></div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-[var(--border-soft)] bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <BrandMark size="md" className="min-w-0" />
          <nav className="flex items-center gap-2">
            <Link href="/login" className="btn btn-ghost text-xs sm:text-sm">ログイン</Link>
            <Link href="/signup" className="btn btn-primary text-xs sm:text-sm">無料で試す</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-24 grid lg:grid-cols-[1fr_.92fr] items-center gap-12 lg:gap-16">
          <div className="min-w-0">
            <span className="eyebrow">AI EMPLOYEE GOVERNANCE</span>
            <h1 className="mt-5 text-[clamp(2.35rem,5vw,4rem)] font-bold tracking-[-0.045em] leading-[1.04]">
              AIを、<br /><span className="text-gradient whitespace-nowrap">社員として雇う</span>
            </h1>
            <p className="mt-6 max-w-xl text-base sm:text-lg muted leading-relaxed">
              権限、承認、上限、監査。AIが働くためのルールを、一つの社員証に
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Link href="/signup" className="btn btn-primary w-full sm:w-auto">14日間、無料で試す</Link>
              <Link href="/app" className="btn btn-ghost w-full sm:w-auto">プロダクトを見る</Link>
            </div>
            <button type="button" popoverTarget="hero-detail" className="mt-5 text-xs muted underline underline-offset-4 hover:text-[var(--text)]">
              Staffpassが必要な理由
            </button>
            <div id="hero-detail" popover="auto" className="info-popover">
              <h2 className="text-base font-semibold">実行力の外側に、会社のルールを</h2>
              <p className="mt-3 text-sm muted leading-relaxed">エージェントを分けるだけでは、共有環境・承認・監査の境界は作れません。Staffpassは、どのAIが何の目的で、どこまで実行できるかを会社側で制御します。</p>
              <button type="button" popoverTarget="hero-detail" popoverTargetAction="hide" className="btn btn-ghost mt-5 text-xs">閉じる</button>
            </div>
          </div>
          <ControlVisual />
        </section>

        <section className="border-y border-[var(--border-soft)] bg-[var(--bg-elevated)]">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col md:flex-row md:items-center gap-5 md:gap-10">
            <p className="text-xs faint shrink-0">対応エージェント</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
              {AGENTS.map((agent) => <div key={agent.name} className={`agent-pill ${agent.active ? "" : "opacity-45"}`}><span>{agent.name}</span><small>{agent.status}</small></div>)}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
          <div className="max-w-2xl">
            <span className="eyebrow">CONTROL BY DESIGN</span>
            <h2 className="mt-4 text-3xl sm:text-5xl font-bold tracking-[-0.045em] leading-tight">分ければ自律化<br />まとめれば、すべて承認</h2>
          </div>
          <div className="mt-10 grid md:grid-cols-3 gap-4">
            {CONTROLS.map((item) => (
              <article key={item.title} className="surface feature-card p-5 sm:p-6">
                <span className="font-mono text-xs text-[var(--accent-strong)]">{item.icon}</span>
                <h3 className="mt-8 text-lg font-semibold">{item.title}</h3>
                <p className="mt-3 text-sm muted leading-relaxed">{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-20 sm:pb-28">
          <div className="surface cta-panel px-5 py-10 sm:p-12 text-center">
            <span className="eyebrow">START SMALL</span>
            <h2 className="mt-4 text-2xl sm:text-4xl font-bold tracking-tight">最初のAI社員に、最初の社員証を</h2>
            <p className="mt-3 text-sm muted">既存のGrok Botにも、新しい環境にも導入できます</p>
            <Link href="/signup" className="btn btn-primary mt-7">トライアルを始める</Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-soft)]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-7 flex flex-col gap-4 text-xs faint">
          <LegalLinks />
          <div className="flex flex-col sm:flex-row justify-between gap-2"><span>Staffpass by Sealith</span><span>© TOKYO307</span></div>
        </div>
      </footer>
    </div>
  );
}
