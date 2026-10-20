/**
 * Shared lock + button view for /login, /signup, /auth/forgot.
 * The lock is a ref so a second click cannot start another request
 * before React re-renders `busy`.
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

export function beginAuthSubmit(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endAuthSubmit(lock: { current: boolean }): void {
  lock.current = false;
}
