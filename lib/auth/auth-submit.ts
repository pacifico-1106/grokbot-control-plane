/**
 * Shared lock + button view for /login, /signup, /auth/forgot.
 * The lock is a ref so a second click cannot start another request
 * before React re-renders `busy`.
 *
 * Named controls must not be `disabled` while native submit is in flight:
 * HTML omits disabled fields from POST, which dropped email / legal_agreement
 * after setBusy → collectTokens → form.submit.
 */

export function authSubmitView(
  busy: boolean,
  idleLabel: string,
  busyLabel: string
): { disabled: boolean; label: string; ariaBusy: boolean } {
  return {
    disabled: busy,
    label: busy ? busyLabel : idleLabel,
    ariaBusy: busy,
  };
}

/** Freeze typing without dropping the control from FormData. */
export function authFieldLock(busy: boolean): { readOnly: boolean; disabled: false } {
  return { readOnly: busy, disabled: false };
}

export function beginAuthSubmit(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endAuthSubmit(lock: { current: boolean }): void {
  lock.current = false;
}

export function authSubmitStillMounted(
  mounted: { current: boolean },
  lock: { current: boolean }
): boolean {
  if (mounted.current) return true;
  endAuthSubmit(lock);
  return false;
}

/** Native submit navigates away. Unlock when it cannot start. */
export function finishNativeAuthSubmit(
  form: HTMLFormElement | null,
  lock: { current: boolean }
): boolean {
  if (!form) {
    endAuthSubmit(lock);
    return false;
  }
  try {
    form.submit();
    return true;
  } catch {
    endAuthSubmit(lock);
    return false;
  }
}
