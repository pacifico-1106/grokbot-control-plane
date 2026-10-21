/**
 * Signing-secret-verified Slack speaker pin.
 *
 * mention-ingress writes the speaker after a successful wake. Gateway invoke
 * reads this pin and ignores request-body speakerId (agent-declared).
 * Slack has no HMAC conversation token like LINE; this stash is the
 * authenticated channel context available in the current structure.
 *
 * TTL matches wake-parent (15 min). Missing / expired pin → fail-closed.
 */
const PIN_TTL_MS = 15 * 60 * 1000;

type SpeakerPin = {
  orgId: string;
  employeeId: string;
  speakerId: string;
  channelId?: string;
  expiresAt: number;
};

const pins = new Map<string, SpeakerPin>();

function pinKey(orgId: string, employeeId: string): string {
  return `${orgId}:${employeeId}`;
}

export function pinAuthenticatedSlackSpeaker(input: {
  orgId: string;
  employeeId: string;
  speakerId: string;
  channelId?: string;
}): void {
  const speakerId = input.speakerId.trim();
  if (!speakerId) return;
  pins.set(pinKey(input.orgId, input.employeeId), {
    orgId: input.orgId,
    employeeId: input.employeeId,
    speakerId,
    channelId: input.channelId,
    expiresAt: Date.now() + PIN_TTL_MS,
  });
}

export function lookupAuthenticatedSlackSpeaker(input: {
  orgId: string;
  employeeId: string;
}): string | null {
  const key = pinKey(input.orgId, input.employeeId);
  const pin = pins.get(key);
  if (!pin) return null;
  if (Date.now() > pin.expiresAt) {
    pins.delete(key);
    return null;
  }
  if (pin.orgId !== input.orgId || pin.employeeId !== input.employeeId) return null;
  return pin.speakerId;
}

export function clearAuthenticatedSlackSpeakers(): void {
  pins.clear();
}

export const AUTHENTICATED_SPEAKER_TTL_MS = PIN_TTL_MS;
