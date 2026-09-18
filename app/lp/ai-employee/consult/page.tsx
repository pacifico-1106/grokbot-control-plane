"use client";

import { Suspense, useState, type FormEvent, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { LegalLinks } from "@/components/LegalLinks";

const PLANS = [
  { value: "intern", label: "インターン（¥50,000/月）" },
  { value: "proper", label: "プロパー（¥150,000/月）" },
  { value: "executive", label: "エグゼクティブ（¥300,000/月）" },
  { value: "custom", label: "カスタマイズ（個別見積）" },
  { value: "undecided", label: "まだ決めていない" },
];

function ConsultForm() {
  const searchParams = useSearchParams();
  const prefillPlan = searchParams.get("plan") || "";

  const [formData, setFormData] = useState({
    plan: prefillPlan,
    company: "",
    name: "",
    email: "",
    phone: "",
    headcount: "",
    useCase: "",
    billingPreference: "monthly",
    honeypot: "",
  });
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (prefillPlan && PLANS.some((p) => p.value === prefillPlan)) {
      setFormData((prev) => ({ ...prev, plan: prefillPlan }));
    }
  }, [prefillPlan]);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (formData.honeypot) {
      setStatus("success");
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      const response = await fetch("/api/lp/ai-employee/inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: formData.plan,
          company: formData.company,
          name: formData.name,
          email: formData.email,
          phone: formData.phone || undefined,
          headcount: formData.headcount || undefined,
          useCase: formData.useCase,
          billingPreference: formData.billingPreference,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };

      if (!response.ok || !data.ok) {
        setStatus("error");
        setErrorMessage(data.message || data.error || "送信に失敗しました");
        return;
      }

      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMessage("ネットワークエラーが発生しました");
    }
  }

  if (status === "success") {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4">
        <div className="w-full max-w-md surface p-6 md:p-8 text-center">
          <BrandMark size="md" href="/lp/ai-employee" />
          <div className="mt-6">
            <div className="w-16 h-16 mx-auto rounded-full bg-[color-mix(in_oklab,var(--ok)_15%,var(--bg))] flex items-center justify-center">
              <svg
                className="w-8 h-8 text-[var(--ok)]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              お問い合わせありがとうございます
            </h1>
            <p className="mt-3 text-sm muted leading-relaxed">
              担当者より1営業日以内にご連絡いたします。
              <br />
              しばらくお待ちください。
            </p>
          </div>
          <div className="mt-8 space-y-3">
            <Link href="/lp/ai-employee" className="btn btn-ghost w-full justify-center">
              AI社員パックのページに戻る
            </Link>
          </div>
          <LegalLinks className="mt-6 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg surface p-6 md:p-8">
        <BrandMark size="md" href="/lp/ai-employee" />
        <h1 className="mt-5 text-2xl font-bold tracking-tight">AI社員パック 相談フォーム</h1>
        <p className="mt-3 text-sm muted leading-relaxed">
          御社の業務に合った導入プランをご提案します。
          <br />
          お気軽にご相談ください。
        </p>

        {status === "error" && (
          <p
            className="mt-4 rounded-lg border border-[color-mix(in_oklab,var(--danger)_40%,var(--border))] bg-[var(--bg-soft)] px-3 py-2 text-sm text-[var(--danger)]"
            role="alert"
          >
            {errorMessage}
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <input
            type="text"
            name="honeypot"
            value={formData.honeypot}
            onChange={handleChange}
            style={{ display: "none" }}
            tabIndex={-1}
            autoComplete="off"
          />

          <label className="block text-sm">
            <span className="muted">
              ご希望のプラン<span className="text-[var(--danger)]">*</span>
            </span>
            <select
              name="plan"
              required
              value={formData.plan}
              onChange={handleChange}
              disabled={status === "submitting"}
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            >
              <option value="">選択してください</option>
              {PLANS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="muted">
              会社名<span className="text-[var(--danger)]">*</span>
            </span>
            <input
              name="company"
              type="text"
              required
              value={formData.company}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="株式会社サンプル"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>

          <label className="block text-sm">
            <span className="muted">
              お名前<span className="text-[var(--danger)]">*</span>
            </span>
            <input
              name="name"
              type="text"
              required
              value={formData.name}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="山田 太郎"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>

          <label className="block text-sm">
            <span className="muted">
              メールアドレス<span className="text-[var(--danger)]">*</span>
            </span>
            <input
              name="email"
              type="email"
              required
              value={formData.email}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="you@company.com"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>

          <label className="block text-sm">
            <span className="muted">電話番号（任意）</span>
            <input
              name="phone"
              type="tel"
              value={formData.phone}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="03-XXXX-XXXX"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>

          <label className="block text-sm">
            <span className="muted">導入予定人数（任意）</span>
            <input
              name="headcount"
              type="text"
              value={formData.headcount}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="1名 / 3名 / 未定"
              className="mt-1 w-full min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)]"
            />
          </label>

          <label className="block text-sm">
            <span className="muted">
              AI社員に任せたい業務<span className="text-[var(--danger)]">*</span>
            </span>
            <textarea
              name="useCase"
              required
              value={formData.useCase}
              onChange={handleChange}
              disabled={status === "submitting"}
              placeholder="例: 日報作成、顧客対応メールの下書き、スケジュール調整など"
              rows={4}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none focus:border-[var(--text-faint)] resize-none"
            />
          </label>

          <fieldset className="text-sm">
            <legend className="muted mb-2">請求の希望</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="billingPreference"
                  value="monthly"
                  checked={formData.billingPreference === "monthly"}
                  onChange={handleChange}
                  disabled={status === "submitting"}
                  className="h-4 w-4 accent-[var(--accent-strong)]"
                />
                <span>月払い</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="billingPreference"
                  value="annual"
                  checked={formData.billingPreference === "annual"}
                  onChange={handleChange}
                  disabled={status === "submitting"}
                  className="h-4 w-4 accent-[var(--accent-strong)]"
                />
                <span>年払い（10%オフ）</span>
              </label>
            </div>
          </fieldset>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={status === "submitting"}
          >
            {status === "submitting" ? "送信中…" : "相談を申し込む"}
          </button>
        </form>

        <p className="mt-4 text-xs faint">
          <Link href="/lp/ai-employee" className="underline">
            AI社員パックのページに戻る
          </Link>
        </p>

        <LegalLinks className="mt-5 border-t border-[var(--border-soft)] pt-4 text-[11px] faint" />
      </div>
    </div>
  );
}

export default function ConsultPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] flex items-center justify-center">
          <div className="w-12 h-12 border-4 border-[var(--border)] border-t-[var(--accent-strong)] rounded-full animate-spin" />
        </div>
      }
    >
      <ConsultForm />
    </Suspense>
  );
}
