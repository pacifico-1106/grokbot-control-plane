"use client";

import { useState } from "react";
import {
  SOD_WARN_DOMAIN_LABELS,
  SOD_WARN_DOMAIN_ORDER,
} from "@/lib/employees/sod-warn-policy";
import { policyErrorMessage } from "@/lib/employees/policy-errors";
import type { SodWarnDomain, SodWarnPolicy } from "@/lib/types";

export function SodWarnPolicyClient({ initialPolicy }: { initialPolicy: SodWarnPolicy }) {
  const [enabled, setEnabled] = useState<Set<SodWarnDomain>>(
    () => new Set(initialPolicy.domains)
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save(next: Set<SodWarnDomain>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/settings/sod-warn-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains: SOD_WARN_DOMAIN_ORDER.filter((d) => next.has(d)) }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(policyErrorMessage(body, "組み合わせの保存に失敗しました"));
      const saved = Array.isArray(body.policy?.domains) ? body.policy.domains : [...next];
      setEnabled(new Set(saved));
      setMessage("組み合わせを保存しました");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "組み合わせの保存に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function toggle(domain: SodWarnDomain) {
    const next = new Set(enabled);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    setEnabled(next);
    void save(next);
  }

  return (
    <section className="surface p-5 space-y-3">
      <h2 className="font-medium">危ない組み合わせ</h2>
      <p className="text-sm muted leading-relaxed">
        警告と承諾だけで、行為は止めません。責任は事業者にあります。完全自動化できます。
      </p>
      <ul className="space-y-2">
        {SOD_WARN_DOMAIN_ORDER.map((domain) => {
          const on = enabled.has(domain);
          return (
            <li key={domain}>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={on}
                  disabled={busy}
                  onChange={() => toggle(domain)}
                />
                <span>
                  <span className="font-medium">{SOD_WARN_DOMAIN_LABELS[domain]}</span>
                  <span className="block text-xs muted mt-0.5">同時に持たせたら警告する</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {message ? <p className="text-xs muted">{message}</p> : null}
    </section>
  );
}
