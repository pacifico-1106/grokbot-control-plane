const sensitiveKeys = new Set([
  "statustoken", "statustokenhash", "pollpath", "pollurl",
  "secrethash", "credentialfingerprint", "onetimesecret", "password",
  "bottoken", "webhooksecret", "channelaccesstoken", "channelsecret",
  "credentialsciphertext", "bottokenciphertext", "secretsciphertext",
]);
export function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    // Commerce uses an authorization *object* for amount/currency/validUntil.
    // Keep that business contract while stripping HTTP Authorization strings.
    return !sensitiveKeys.has(normalized) &&
      (normalized !== "authorization" || (item !== null && typeof item === "object" && !Array.isArray(item)));
  }).map(([key, item]) => [key, redactMetadata(item)]));
}
