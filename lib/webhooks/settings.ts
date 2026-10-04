// fail-first stub (D9) — replaced by the implementation commit
const ni = (): never => { throw new Error("not_implemented"); };
export type CallbackPayloadMode = "minimal" | "legacy_full";
export function __resetWebhookSettingsForTests(): void {}
export function __setWebhookSettingsFailureForTests(_v: boolean): void {}
export async function getCallbackWebhookConfig(_e: string, _o: string): Promise<Record<string, unknown>> { return ni(); }
export async function mintCallbackSigningSecret(_e: string, _o: string): Promise<{ secret: string; fingerprint: string }> { return ni(); }
export async function setCallbackPayloadMode(_e: string, _o: string, _m: CallbackPayloadMode): Promise<void> { return ni(); }
export async function getWebhookSettingsView(_e: string, _o: string): Promise<Record<string, unknown>> { return ni(); }
