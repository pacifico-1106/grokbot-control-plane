function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}
export function matchesSuperAdminAllowlist(input: {
  userId: string;
  email: string;
  userIds?: string;
  emails?: string;
}): boolean {
  const allowedUserIds = parseAllowlist(input.userIds);
  const allowedEmails = parseAllowlist(input.emails);

  return (
    allowedUserIds.has(input.userId.trim().toLowerCase()) ||
    allowedEmails.has(input.email.trim().toLowerCase())
  );
}
