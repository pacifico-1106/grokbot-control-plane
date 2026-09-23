/**
 * P1 External Contract Card Setup Feature Flag
 *
 * CRITICAL: Default OFF (0). Production enable requires:
 * 1. Full security audit
 * 2. Separate prod-enable GO from security team
 *
 * Do NOT claim SAQ A achieved until audit complete.
 * This flag controls all card setup endpoints — when OFF, they are inert.
 *
 * @see docs/p1-external-contract-card-registration-design-20260923.md
 */

export const EXTERNAL_CONTRACT_CARD_SETUP_FLAG =
  "EXTERNAL_CONTRACT_CARD_SETUP";

/**
 * Check if external contract card setup feature is enabled.
 * Default: OFF (0, empty, or unset = disabled).
 *
 * Enable only in non-production environments for testing.
 * Production enable requires full security audit + separate GO.
 */
export function isExternalContractCardSetupEnabled(): boolean {
  const value = process.env[EXTERNAL_CONTRACT_CARD_SETUP_FLAG];
  return value === "1" || value === "true";
}

/**
 * Feature flag check result for API responses.
 * Returns error response object when flag is OFF.
 */
export function checkExternalContractCardSetupFlag(): {
  enabled: boolean;
  error?: {
    ok: false;
    code: "feature_disabled";
    error: "external_contract_card_setup_disabled";
    messageJa: string;
    nextStepJa: string;
  };
} {
  if (isExternalContractCardSetupEnabled()) {
    return { enabled: true };
  }

  return {
    enabled: false,
    error: {
      ok: false,
      code: "feature_disabled",
      error: "external_contract_card_setup_disabled",
      messageJa:
        "外部契約カード登録機能は現在無効です。本番有効化には完全なセキュリティ監査と別途GOが必要です。",
      nextStepJa:
        "この機能は開発中です。セキュリティ監査完了後に有効化されます。",
    },
  };
}

/**
 * Type guard for feature flag error response.
 */
export function isFeatureFlagError(
  result: ReturnType<typeof checkExternalContractCardSetupFlag>
): result is {
  enabled: false;
  error: NonNullable<
    ReturnType<typeof checkExternalContractCardSetupFlag>["error"]
  >;
} {
  return !result.enabled && result.error !== undefined;
}
