/**
 * A1 v2 org region dictionary resolution.
 * No shared world geo master — org-specific dictionary only.
 */
import type { OrgRegionDictionary } from "@/lib/types";

/**
 * Resolve a region hint (code, alias, or label) to a canonical region code.
 * Returns null when not found in the org dictionary.
 */
export function resolveRegionCode(
  hint: string | undefined | null,
  dictionary: OrgRegionDictionary | undefined
): string | null {
  if (!hint || !dictionary) {
    return null;
  }

  const normalized = hint.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const region of dictionary.regions) {
    if (region.code.toLowerCase() === normalized) {
      return region.code;
    }
    if (region.labelJa.toLowerCase() === normalized) {
      return region.code;
    }
    if (region.aliases?.some((alias) => alias.toLowerCase() === normalized)) {
      return region.code;
    }
  }

  return null;
}

/**
 * Resolve country for a region code using the org dictionary.
 */
export function resolveRegionCountry(
  regionCode: string,
  dictionary: OrgRegionDictionary | undefined
): string | null {
  if (!dictionary) {
    return null;
  }
  const region = dictionary.regions.find((r) => r.code === regionCode);
  return region?.country ?? dictionary.defaultCountry;
}
