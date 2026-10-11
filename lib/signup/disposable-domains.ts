/**
 * Static disposable / throwaway mailbox domains (lower-case).
 * Intentionally small and conservative: only well-known throwaway services.
 * Extend via SIGNUP_EXTRA_DISPOSABLE_DOMAINS (comma-separated) without a deploy.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "33mail.com",
  "anonaddy.me", "burnermail.io", "byom.de", "discard.email", "dispostable.com",
  "dropmail.me", "emailondeck.com", "fakeinbox.com", "fakemail.net", "getairmail.com",
  "getnada.com", "guerrillamail.biz", "guerrillamail.com", "guerrillamail.de",
  "guerrillamail.info", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com",
  "harakirimail.com", "inboxbear.com", "inboxkitten.com", "incognitomail.org",
  "jetable.org", "mail.tm", "mail-temp.com", "mailcatch.com", "maildrop.cc",
  "mailinator.com", "mailinator.net", "mailinator2.com", "mailnesia.com", "mailpoof.com",
  "mintemail.com", "mohmal.com", "moakt.com", "mytemp.email", "nada.email",
  "sharklasers.com", "spam4.me", "spambog.com", "spamgourmet.com", "temp-mail.io",
  "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.dev", "tempmail.net",
  "tempmailo.com", "tempr.email", "throwawaymail.com", "trashmail.com", "trashmail.de",
  "trashmail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "emailfake.com",
  "grr.la", "pokemail.net", "spamex.com", "mvrht.net", "tmail.ws", "tmpmail.org",
  "tmpmail.net", "1secmail.com", "1secmail.net", "1secmail.org", "linshiyouxiang.net",
]);

export function extraDisposableDomains(): Set<string> {
  return new Set(
    (process.env.SIGNUP_EXTRA_DISPOSABLE_DOMAINS || "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
  );
}

/** True for a listed domain or any subdomain of one. */
export function isDisposableDomain(domain: string, extra: Set<string> = extraDisposableDomains()): boolean {
  const d = (domain || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d) return false;
  const parts = d.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (DISPOSABLE_EMAIL_DOMAINS.has(candidate) || extra.has(candidate)) return true;
  }
  return false;
}
