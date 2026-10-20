/**
 * Turnstile ON native POST: named controls must still appear in FormData
 * after the busy lock (setBusy → collectTokens → form.submit).
 *
 * HTML omits disabled controls. These tests build a real FormData from the
 * same lock props the forms apply — not a source grep.
 */
import { describe, expect, test } from "bun:test";
import { authFieldLock } from "./auth-submit";

type Control = {
  name: string;
  value: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  checked?: boolean;
};

/** WHATWG successful-controls subset used by forgot / signup. */
function formDataFromControls(controls: Control[]): FormData {
  const body = new FormData();
  for (const control of controls) {
    if (control.disabled) continue;
    if (!control.name) continue;
    const type = control.type || "text";
    if ((type === "checkbox" || type === "radio") && !control.checked) continue;
    body.append(control.name, control.value);
  }
  return body;
}

describe("HTML FormData omits disabled controls", () => {
  test("disabled email is absent (the production bug this file guards)", () => {
    const body = formDataFromControls([
      { name: "email", value: "user@example.com", type: "email", disabled: true },
    ]);
    expect(body.get("email")).toBeNull();
    expect(body.has("email")).toBe(false);
  });

  test("readOnly email is present", () => {
    const body = formDataFromControls([
      { name: "email", value: "user@example.com", type: "email", readOnly: true, disabled: false },
    ]);
    expect(body.get("email")).toBe("user@example.com");
  });
});

describe("Turnstile ON: busy lock still posts required fields", () => {
  test("authFieldLock never disables a named control", () => {
    const idle = authFieldLock(false);
    const busy = authFieldLock(true);
    expect(idle.disabled).toBe(false);
    expect(busy.disabled).toBe(false);
    expect(idle.readOnly).toBe(false);
    expect(busy.readOnly).toBe(true);
  });

  test("forgot: FormData includes email and captcha tokens while busy", () => {
    const lock = authFieldLock(true);
    const body = formDataFromControls([
      { name: "email", value: "user@example.com", type: "email", ...lock },
      { name: "cf-turnstile-response", value: "tok-local" },
      { name: "cf-turnstile-supabase", value: "tok-unused" },
    ]);
    expect(body.get("email")).toBe("user@example.com");
    expect(body.get("cf-turnstile-response")).toBe("tok-local");
    expect(body.get("cf-turnstile-supabase")).toBe("tok-unused");
  });

  test("signup: FormData includes every required field while busy", () => {
    const lock = authFieldLock(true);
    const body = formDataFromControls([
      { name: "orgName", value: "株式会社テスト", ...lock },
      { name: "email", value: "owner@example.com", type: "email", ...lock },
      { name: "password", value: "correct-horse", type: "password", ...lock },
      { name: "mode", value: "managed", ...lock },
      {
        name: "legal_agreement",
        type: "checkbox",
        value: "accepted",
        checked: true,
        ...lock,
      },
      { name: "cf-turnstile-response", value: "tok-local" },
      { name: "cf-turnstile-supabase", value: "tok-unused" },
    ]);
    expect(body.get("orgName")).toBe("株式会社テスト");
    expect(body.get("email")).toBe("owner@example.com");
    expect(body.get("password")).toBe("correct-horse");
    expect(body.get("mode")).toBe("managed");
    expect(body.get("legal_agreement")).toBe("accepted");
    expect(body.get("cf-turnstile-response")).toBe("tok-local");
    expect(body.get("cf-turnstile-supabase")).toBe("tok-unused");
  });
});
