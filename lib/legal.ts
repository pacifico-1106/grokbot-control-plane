import "server-only";

function value(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw || null;
}

export type LegalIdentity = {
  serviceName: string;
  providerName: string;
  address: string;
  phone: string;
  corporateRepresentative: string;
  responsiblePerson: string;
  contactEmail: string;
  effectiveDate: string;
  siteUrl: string;
  configured: boolean;
};

/**
 * Legal identity is server-configured so placeholder business details never
 * get hard-coded as fact. The omission copy follows the disclosure-on-request
 * option described by the Consumer Affairs Agency for mail-order advertising.
 */
export function getLegalIdentity(): LegalIdentity {
  const providerName = value("LEGAL_PROVIDER_NAME") || "トーキョーサンマルナナ株式会社";
  const address = value("LEGAL_PROVIDER_ADDRESS") || "〒105-0013 東京都港区浜松町2-2-15 2F";
  const phone = value("LEGAL_PROVIDER_PHONE");
  const corporateRepresentative = value("LEGAL_REPRESENTATIVE_NAME") || "八坂 太洋";
  const responsiblePerson = value("LEGAL_RESPONSIBLE_PERSON") || "安藤 達也";
  const contactEmail = value("LEGAL_CONTACT_EMAIL") || "info@tokyo307inc.com";

  return {
    serviceName: "Staffpass",
    providerName,
    address,
    phone: phone || "請求があり次第、遅滞なく開示します",
    corporateRepresentative,
    responsiblePerson,
    contactEmail,
    effectiveDate: value("LEGAL_EFFECTIVE_DATE") || "2026年8月26日",
    siteUrl: value("NEXT_PUBLIC_APP_URL") || "https://grokbot-control-plane.vercel.app",
    configured: Boolean(phone),
  };
}
