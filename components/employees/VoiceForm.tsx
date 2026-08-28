"use client";

import {
  VOICE_ENDINGS_LABELS_JA,
  VOICE_HELPER_JA,
  VOICE_REGISTER_LABELS_JA,
  VOICE_TEMPLATE_LABELS_JA,
  applyVoiceTemplate,
} from "@/lib/employees/voice";
import type { EmployeeVoice, VoiceEndings, VoiceRegister, VoiceTemplate } from "@/lib/types";

const TEMPLATES: VoiceTemplate[] = ["polite", "frank", "custom"];
const ENDINGS: VoiceEndings[] = ["desumasu", "da-dearu", "either"];
const REGISTERS: VoiceRegister[] = ["polite", "frank"];

export function VoiceForm({
  value,
  onChange,
  disabled,
}: {
  value: EmployeeVoice;
  onChange: (voice: EmployeeVoice) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm muted">話し方（社員証）</legend>
        <div className="flex flex-wrap gap-3">
          {TEMPLATES.map((template) => (
            <label key={template} className="inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="employee-voice-template"
                disabled={disabled}
                checked={value.template === template}
                onChange={() => onChange(applyVoiceTemplate(template, value))}
              />
              {VOICE_TEMPLATE_LABELS_JA[template]}
            </label>
          ))}
        </div>
      </fieldset>

      {value.template === "custom" ? (
        <div className="space-y-3 rounded-xl border border-[var(--border-soft)] bg-[var(--bg-soft)] px-3 py-3">
          <label className="block text-sm">
            <span className="muted">禁止語（カンマ区切り）</span>
            <input
              disabled={disabled}
              value={value.forbidden.join("、")}
              onChange={(e) =>
                onChange({
                  ...value,
                  template: "custom",
                  forbidden: e.target.value
                    .split(/[,、]/)
                    .map((item) => item.trim())
                    .filter(Boolean),
                  externalFloor: "polite",
                })
              }
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              placeholder="了解、ぶっちゃけ"
            />
          </label>
          <label className="block text-sm">
            <span className="muted">締めの一文</span>
            <input
              disabled={disabled}
              value={value.signOff ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  template: "custom",
                  signOff: e.target.value.trim() || null,
                  externalFloor: "polite",
                })
              }
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
              placeholder="何卒よろしくお願いいたします"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm muted">語尾</legend>
            <div className="flex flex-wrap gap-3">
              {ENDINGS.map((endings) => (
                <label key={endings} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="employee-voice-endings"
                    disabled={disabled}
                    checked={value.endings === endings}
                    onChange={() =>
                      onChange({
                        ...value,
                        template: "custom",
                        endings,
                        externalFloor: "polite",
                      })
                    }
                  />
                  {VOICE_ENDINGS_LABELS_JA[endings]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm muted">レジスタ</legend>
            <div className="flex flex-wrap gap-3">
              {REGISTERS.map((register) => (
                <label key={register} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="employee-voice-register"
                    disabled={disabled}
                    checked={value.register === register}
                    onChange={() =>
                      onChange({
                        ...value,
                        template: "custom",
                        register,
                        externalFloor: "polite",
                      })
                    }
                  />
                  {VOICE_REGISTER_LABELS_JA[register]}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}

      <p className="text-[11px] faint leading-relaxed">{VOICE_HELPER_JA}</p>
    </div>
  );
}
