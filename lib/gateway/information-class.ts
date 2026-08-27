/**
 * Information class (WHAT) + disclosure fidelity.
 * Unclassified assets / unknown outbound body → confidential.
 */

import { getInformationAsset } from "@/lib/data/directory";
import type {
  DisclosureFidelity,
  GatewayInvokeRequest,
  InformationClass,
} from "@/lib/types";

const CLASSES: InformationClass[] = ["public", "internal", "confidential", "verbatim"];
const FIDELITIES: DisclosureFidelity[] = ["summary", "source"];

const CLASS_RANK: Record<InformationClass, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  verbatim: 3,
};

export function isInformationClass(value: unknown): value is InformationClass {
  return typeof value === "string" && CLASSES.includes(value as InformationClass);
}

export function isDisclosureFidelity(value: unknown): value is DisclosureFidelity {
  return typeof value === "string" && FIDELITIES.includes(value as DisclosureFidelity);
}

export function maxInformationClass(classes: InformationClass[]): InformationClass {
  if (!classes.length) return "confidential";
  return classes.reduce((highest, item) =>
    CLASS_RANK[item] > CLASS_RANK[highest] ? item : highest
  );
}

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function collectAssetRefs(args: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const single = str(args.assetRef) || str(args.asset) || str(args.ref);
  if (single) refs.push(single);
  const list = args.assetRefs ?? args.assets ?? args.includedAssets;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === "string" && item.trim()) refs.push(item.trim());
      else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const ref = str(rec.ref) || str(rec.assetRef) || str(rec.id);
        if (ref) refs.push(ref);
      }
    }
  }
  return [...new Set(refs)];
}

function calendarLooksDetailed(args: Record<string, unknown>): boolean {
  if (args.detail === true || args.includeDetails === true || args.source === true) return true;
  const disclosure = str(args.disclosure) || str(args.fidelity);
  if (disclosure === "source" || disclosure === "detail") return true;
  if (args.title === true || args.attendees === true) return true;
  return false;
}

export function toolDefaultClassification(tool: string, args: Record<string, unknown>): {
  informationClass: InformationClass;
  fidelity: DisclosureFidelity;
} {
  if (tool === "calendar.read" || tool === "calendar.propose") {
    return calendarLooksDetailed(args)
      ? { informationClass: "internal", fidelity: "source" }
      : { informationClass: "internal", fidelity: "summary" };
  }
  if (tool === "knowledge.search" || tool === "files.read") {
    return { informationClass: "confidential", fidelity: "source" };
  }
  if (
    tool === "mail.send" ||
    tool === "mail.draft" ||
    tool === "comm.send" ||
    tool === "comm.reply" ||
    tool === "slack.post" ||
    tool === "slack.post_external"
  ) {
    return { informationClass: "confidential", fidelity: "source" };
  }
  return { informationClass: "confidential", fidelity: "source" };
}

export async function resolveInformationDisclosure(input: {
  orgId: string;
  tool: string;
  body: GatewayInvokeRequest;
}): Promise<{ informationClass: InformationClass; fidelity: DisclosureFidelity; unclassified: boolean }> {
  const args = (input.body.args && typeof input.body.args === "object" ? input.body.args : {}) as Record<string, unknown>;
  const explicitClass =
    (isInformationClass(input.body.informationClass) && input.body.informationClass) ||
    (isInformationClass(args.informationClass) && args.informationClass) ||
    (isInformationClass(args.class) && args.class) ||
    null;
  const explicitFidelity =
    (isDisclosureFidelity(input.body.disclosure) && input.body.disclosure) ||
    (isDisclosureFidelity(args.disclosure) && args.disclosure) ||
    (isDisclosureFidelity(args.fidelity) && args.fidelity) ||
    (args.disclosure === "detail" || args.fidelity === "detail" ? "source" : null);

  const refs = collectAssetRefs(args);
  const assetClasses: InformationClass[] = [];
  let sawUnknownAsset = false;
  for (const ref of refs) {
    const asset = await getInformationAsset(input.orgId, ref);
    if (!asset) {
      sawUnknownAsset = true;
      assetClasses.push("confidential");
    } else {
      assetClasses.push(asset.class);
    }
  }

  const defaults = toolDefaultClassification(input.tool, args);
  const inherited = assetClasses.length ? maxInformationClass(assetClasses) : null;
  const informationClass = explicitClass ?? inherited ?? defaults.informationClass;
  const fidelity = explicitFidelity ?? defaults.fidelity;
  const unclassified = !explicitClass && !inherited && (sawUnknownAsset || !refs.length) && !explicitClass;

  return {
    informationClass,
    fidelity,
    unclassified: !explicitClass && (sawUnknownAsset || (!inherited && defaults.informationClass === "confidential" && !refs.length && (input.tool === "knowledge.search" || input.tool === "files.read" || sawUnknownAsset))),
  };
}
