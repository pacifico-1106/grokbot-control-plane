/**
 * A1 scheduling.policy validation and normalization.
 * First rule-pack that locks the shared pack shape for all future situation policies.
 * Fail-closed: missing/conflicting rules → do not widen candidates; escalate to human.
 */
import type {
  AreaPolicy,
  CalendarSources,
  ConfirmAutomationLevel,
  FreeBusyMergeMode,
  LocationAffinity,
  MeetingModeKind,
  MeetingModePolicy,
  MeetingModeStrategy,
  OnUnspecifiedMeetingMode,
  OnUnknownRegion,
  OnlineMeetingPack,
  OnlineVideoToolEntry,
  OrgRegionDictionary,
  OrgRegionEntry,
  OrgSchedulingPolicy,
  SchedulingRule,
  TimeWindow,
  TravelFeasibility,
} from "@/lib/types";

const LOCATION_AFFINITY_VALUES: LocationAffinity[] = [
  "office_first",
  "remote_first",
  "hybrid",
  "any",
];

const CONFIRM_AUTOMATION_VALUES: ConfirmAutomationLevel[] = [
  "always_human",
  "risk_based",
  "conditional",
  "full_auto",
];

const HIGH_RISK_AUTOMATION_LEVELS: ConfirmAutomationLevel[] = [
  "risk_based",
  "conditional",
  "full_auto",
];

const FREE_BUSY_MERGE_VALUES: FreeBusyMergeMode[] = ["union_busy"];
const MEETING_MODE_STRATEGY_VALUES: MeetingModeStrategy[] = ["title_tag", "explicit_only"];
const MEETING_MODE_KIND_VALUES: MeetingModeKind[] = ["online", "in_person"];
const ON_UNSPECIFIED_MEETING_MODE_VALUES: OnUnspecifiedMeetingMode[] = ["drop", "escalate"];
const ON_UNKNOWN_REGION_VALUES: OnUnknownRegion[] = ["drop", "escalate", "allow"];

const RULE_ALLOWED_KEYS = new Set([
  "id",
  "priority",
  "locationAffinity",
  "travelBufferMinutes",
  "onlinePack",
  "hardBlackout",
  "softPrefer",
  "costCapJpy",
  "confirmAutomation",
  "calendarSources",
  "meetingMode",
  "areaPolicy",
  "travelFeasibility",
]);

const POLICY_ALLOWED_KEYS = new Set([
  "version",
  "policyId",
  "policyName",
  "rules",
  "regionDictionary",
  "highRiskConsentAt",
  "highRiskConsentBy",
  "updatedAt",
  "updatedBy",
]);

const CALENDAR_SOURCES_ALLOWED_KEYS = new Set(["ids", "freeBusyMerge"]);
const MEETING_MODE_ALLOWED_KEYS = new Set([
  "strategy",
  "onlineTitleTags",
  "defaultMode",
  "onUnspecified",
]);
const AREA_POLICY_ALLOWED_KEYS = new Set([
  "allowCountries",
  "denyCountries",
  "allowRegions",
  "denyRegions",
  "onUnknownRegion",
]);
const TRAVEL_FEASIBILITY_ALLOWED_KEYS = new Set(["maxOneWayMinutes", "requireBuffer"]);
const REGION_DICTIONARY_ALLOWED_KEYS = new Set(["version", "defaultCountry", "regions"]);
const REGION_ENTRY_ALLOWED_KEYS = new Set(["code", "labelJa", "aliases", "country"]);

export type ValidationError = {
  ruleIndex?: number;
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ValidationResult =
  | { ok: true; policy: OrgSchedulingPolicy }
  | { ok: false; errors: ValidationError[] };

function isLocationAffinity(value: unknown): value is LocationAffinity {
  return (
    typeof value === "string" &&
    LOCATION_AFFINITY_VALUES.includes(value as LocationAffinity)
  );
}

function isConfirmAutomation(value: unknown): value is ConfirmAutomationLevel {
  return (
    typeof value === "string" &&
    CONFIRM_AUTOMATION_VALUES.includes(value as ConfirmAutomationLevel)
  );
}

function isHighRiskAutomation(level: ConfirmAutomationLevel): boolean {
  return HIGH_RISK_AUTOMATION_LEVELS.includes(level);
}

function generateRuleId(): string {
  return `spr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function generatePolicyId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function collectUnknownFieldErrors(
  rec: Record<string, unknown>,
  allowed: Set<string>,
  fieldPath: string,
  ruleIndex?: number
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      errors.push({
        ruleIndex,
        field: `${fieldPath}.${key}`,
        code: "unknown_field",
        message: `Unknown field: ${fieldPath}.${key}`,
        messageJa: `未知のフィールド: ${fieldPath}.${key}`,
      });
    }
  }
  return errors;
}

function validateStringArray(
  raw: unknown,
  fieldPath: string,
  ruleIndex?: number
): { ok: true; values: string[] } | { ok: false; errors: ValidationError[] } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          ruleIndex,
          field: fieldPath,
          code: "invalid_string_array",
          message: `${fieldPath} must be an array of strings`,
          messageJa: `${fieldPath} は文字列配列でなければなりません`,
        },
      ],
    };
  }
  const values: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string" || !raw[i].trim()) {
      return {
        ok: false,
        errors: [
          {
            ruleIndex,
            field: `${fieldPath}[${i}]`,
            code: "invalid_string_array_item",
            message: `${fieldPath}[${i}] must be a non-empty string`,
            messageJa: `${fieldPath}[${i}] は空でない文字列でなければなりません`,
          },
        ],
      };
    }
    values.push(raw[i].trim());
  }
  return { ok: true, values };
}

function validateCalendarSources(
  raw: unknown,
  index: number
): { ok: true; sources: CalendarSources } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          ruleIndex: index,
          field: "calendarSources",
          code: "invalid_calendar_sources_format",
          message: "calendarSources must be an object",
          messageJa: "calendarSources はオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(rec, CALENDAR_SOURCES_ALLOWED_KEYS, "calendarSources", index);

  const idsResult = validateStringArray(rec.ids, "calendarSources.ids", index);
  if (!idsResult.ok) {
    errors.push(...idsResult.errors);
  }

  if (
    typeof rec.freeBusyMerge !== "string" ||
    !FREE_BUSY_MERGE_VALUES.includes(rec.freeBusyMerge as FreeBusyMergeMode)
  ) {
    errors.push({
      ruleIndex: index,
      field: "calendarSources.freeBusyMerge",
      code: "invalid_free_busy_merge",
      message: `freeBusyMerge must be one of: ${FREE_BUSY_MERGE_VALUES.join(", ")}`,
      messageJa: `freeBusyMerge は ${FREE_BUSY_MERGE_VALUES.join(" / ")} のいずれかです`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    sources: {
      ids: idsResult.ok ? idsResult.values : [],
      freeBusyMerge: rec.freeBusyMerge as FreeBusyMergeMode,
    },
  };
}

function validateMeetingMode(
  raw: unknown,
  index: number
): { ok: true; meetingMode: MeetingModePolicy } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          ruleIndex: index,
          field: "meetingMode",
          code: "invalid_meeting_mode_format",
          message: "meetingMode must be an object",
          messageJa: "meetingMode はオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(rec, MEETING_MODE_ALLOWED_KEYS, "meetingMode", index);

  if (
    typeof rec.strategy !== "string" ||
    !MEETING_MODE_STRATEGY_VALUES.includes(rec.strategy as MeetingModeStrategy)
  ) {
    errors.push({
      ruleIndex: index,
      field: "meetingMode.strategy",
      code: "invalid_meeting_mode_strategy",
      message: `strategy must be one of: ${MEETING_MODE_STRATEGY_VALUES.join(", ")}`,
      messageJa: `strategy は ${MEETING_MODE_STRATEGY_VALUES.join(" / ")} のいずれかです`,
    });
  }

  if (rec.onlineTitleTags !== undefined) {
    const tagsResult = validateStringArray(rec.onlineTitleTags, "meetingMode.onlineTitleTags", index);
    if (!tagsResult.ok) {
      errors.push(...tagsResult.errors);
    }
  }

  if (
    rec.defaultMode !== undefined &&
    (typeof rec.defaultMode !== "string" ||
      !MEETING_MODE_KIND_VALUES.includes(rec.defaultMode as MeetingModeKind))
  ) {
    errors.push({
      ruleIndex: index,
      field: "meetingMode.defaultMode",
      code: "invalid_meeting_mode_default",
      message: `defaultMode must be one of: ${MEETING_MODE_KIND_VALUES.join(", ")}`,
      messageJa: `defaultMode は ${MEETING_MODE_KIND_VALUES.join(" / ")} のいずれかです`,
    });
  }

  if (
    typeof rec.onUnspecified !== "string" ||
    !ON_UNSPECIFIED_MEETING_MODE_VALUES.includes(rec.onUnspecified as OnUnspecifiedMeetingMode)
  ) {
    errors.push({
      ruleIndex: index,
      field: "meetingMode.onUnspecified",
      code: "invalid_meeting_mode_on_unspecified",
      message: `onUnspecified must be one of: ${ON_UNSPECIFIED_MEETING_MODE_VALUES.join(", ")}`,
      messageJa: `onUnspecified は ${ON_UNSPECIFIED_MEETING_MODE_VALUES.join(" / ")} のいずれかです`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const meetingMode: MeetingModePolicy = {
    strategy: rec.strategy as MeetingModeStrategy,
    onUnspecified: rec.onUnspecified as OnUnspecifiedMeetingMode,
  };

  if (Array.isArray(rec.onlineTitleTags)) {
    const tagsResult = validateStringArray(rec.onlineTitleTags, "meetingMode.onlineTitleTags", index);
    if (tagsResult.ok && tagsResult.values.length > 0) {
      meetingMode.onlineTitleTags = tagsResult.values;
    }
  }

  if (
    typeof rec.defaultMode === "string" &&
    MEETING_MODE_KIND_VALUES.includes(rec.defaultMode as MeetingModeKind)
  ) {
    meetingMode.defaultMode = rec.defaultMode as MeetingModeKind;
  }

  return { ok: true, meetingMode };
}

function validateAreaPolicy(
  raw: unknown,
  index: number
): { ok: true; areaPolicy: AreaPolicy } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          ruleIndex: index,
          field: "areaPolicy",
          code: "invalid_area_policy_format",
          message: "areaPolicy must be an object",
          messageJa: "areaPolicy はオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(rec, AREA_POLICY_ALLOWED_KEYS, "areaPolicy", index);
  const areaPolicy: AreaPolicy = {};

  for (const key of ["allowCountries", "denyCountries", "allowRegions", "denyRegions"] as const) {
    if (rec[key] !== undefined) {
      const result = validateStringArray(rec[key], `areaPolicy.${key}`, index);
      if (!result.ok) {
        errors.push(...result.errors);
      } else if (result.values.length > 0) {
        areaPolicy[key] = result.values;
      }
    }
  }

  if (
    rec.onUnknownRegion !== undefined &&
    (typeof rec.onUnknownRegion !== "string" ||
      !ON_UNKNOWN_REGION_VALUES.includes(rec.onUnknownRegion as OnUnknownRegion))
  ) {
    errors.push({
      ruleIndex: index,
      field: "areaPolicy.onUnknownRegion",
      code: "invalid_on_unknown_region",
      message: `onUnknownRegion must be one of: ${ON_UNKNOWN_REGION_VALUES.join(", ")}`,
      messageJa: `onUnknownRegion は ${ON_UNKNOWN_REGION_VALUES.join(" / ")} のいずれかです`,
    });
  } else if (typeof rec.onUnknownRegion === "string") {
    areaPolicy.onUnknownRegion = rec.onUnknownRegion as OnUnknownRegion;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, areaPolicy };
}

function validateTravelFeasibility(
  raw: unknown,
  index: number
): { ok: true; travelFeasibility: TravelFeasibility } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          ruleIndex: index,
          field: "travelFeasibility",
          code: "invalid_travel_feasibility_format",
          message: "travelFeasibility must be an object",
          messageJa: "travelFeasibility はオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(
    rec,
    TRAVEL_FEASIBILITY_ALLOWED_KEYS,
    "travelFeasibility",
    index
  );
  const travelFeasibility: TravelFeasibility = {};

  if (rec.maxOneWayMinutes !== undefined) {
    const minutes = Number(rec.maxOneWayMinutes);
    if (!Number.isFinite(minutes) || minutes < 0) {
      errors.push({
        ruleIndex: index,
        field: "travelFeasibility.maxOneWayMinutes",
        code: "invalid_max_one_way_minutes",
        message: "maxOneWayMinutes must be a non-negative number",
        messageJa: "maxOneWayMinutes は 0 以上の数値でなければなりません",
      });
    } else {
      travelFeasibility.maxOneWayMinutes = minutes;
    }
  }

  if (rec.requireBuffer !== undefined) {
    if (typeof rec.requireBuffer !== "boolean") {
      errors.push({
        ruleIndex: index,
        field: "travelFeasibility.requireBuffer",
        code: "invalid_require_buffer",
        message: "requireBuffer must be a boolean",
        messageJa: "requireBuffer は boolean でなければなりません",
      });
    } else {
      travelFeasibility.requireBuffer = rec.requireBuffer;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, travelFeasibility };
}

function validateRegionEntry(
  raw: unknown,
  index: number
): { ok: true; entry: OrgRegionEntry } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          field: `regionDictionary.regions[${index}]`,
          code: "invalid_region_entry_format",
          message: "Region entry must be an object",
          messageJa: "地域エントリはオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(
    rec,
    REGION_ENTRY_ALLOWED_KEYS,
    `regionDictionary.regions[${index}]`
  );

  if (typeof rec.code !== "string" || !rec.code.trim()) {
    errors.push({
      field: `regionDictionary.regions[${index}].code`,
      code: "invalid_region_code",
      message: "Region code is required",
      messageJa: "地域コードは必須です",
    });
  }

  if (typeof rec.labelJa !== "string" || !rec.labelJa.trim()) {
    errors.push({
      field: `regionDictionary.regions[${index}].labelJa`,
      code: "invalid_region_label",
      message: "Region labelJa is required",
      messageJa: "地域ラベル（日本語）は必須です",
    });
  }

  if (rec.aliases !== undefined) {
    const aliasesResult = validateStringArray(
      rec.aliases,
      `regionDictionary.regions[${index}].aliases`
    );
    if (!aliasesResult.ok) {
      errors.push(...aliasesResult.errors);
    }
  }

  if (rec.country !== undefined && (typeof rec.country !== "string" || !rec.country.trim())) {
    errors.push({
      field: `regionDictionary.regions[${index}].country`,
      code: "invalid_region_country",
      message: "Region country must be a non-empty string",
      messageJa: "地域の国コードは空でない文字列でなければなりません",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const entry: OrgRegionEntry = {
    code: (rec.code as string).trim(),
    labelJa: (rec.labelJa as string).trim(),
  };

  if (Array.isArray(rec.aliases)) {
    const aliasesResult = validateStringArray(
      rec.aliases,
      `regionDictionary.regions[${index}].aliases`
    );
    if (aliasesResult.ok && aliasesResult.values.length > 0) {
      entry.aliases = aliasesResult.values;
    }
  }

  if (typeof rec.country === "string" && rec.country.trim()) {
    entry.country = rec.country.trim();
  }

  return { ok: true, entry };
}

function validateRegionDictionary(
  raw: unknown
): { ok: true; dictionary: OrgRegionDictionary } | { ok: false; errors: ValidationError[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        {
          field: "regionDictionary",
          code: "invalid_region_dictionary_format",
          message: "regionDictionary must be an object",
          messageJa: "regionDictionary はオブジェクトでなければなりません",
        },
      ],
    };
  }

  const rec = raw as Record<string, unknown>;
  const errors = collectUnknownFieldErrors(rec, REGION_DICTIONARY_ALLOWED_KEYS, "regionDictionary");

  if (rec.version !== 1) {
    errors.push({
      field: "regionDictionary.version",
      code: "invalid_region_dictionary_version",
      message: "regionDictionary.version must be 1",
      messageJa: "regionDictionary.version は 1 でなければなりません",
    });
  }

  const defaultCountry =
    typeof rec.defaultCountry === "string" && rec.defaultCountry.trim()
      ? rec.defaultCountry.trim()
      : "JP";

  if (!Array.isArray(rec.regions)) {
    errors.push({
      field: "regionDictionary.regions",
      code: "regions_required",
      message: "regionDictionary.regions array is required",
      messageJa: "regionDictionary.regions 配列が必要です",
    });
    return { ok: false, errors };
  }

  const regions: OrgRegionEntry[] = [];
  for (let i = 0; i < rec.regions.length; i++) {
    const result = validateRegionEntry(rec.regions[i], i);
    if (result.ok) {
      regions.push(result.entry);
    } else {
      errors.push(...result.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    dictionary: {
      version: 1,
      defaultCountry,
      regions,
    },
  };
}

function validateTimeWindow(
  raw: unknown,
  index: number,
  fieldName: string,
  windowIndex: number
): { ok: true; window: TimeWindow } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: `${fieldName}[${windowIndex}]`,
      code: "invalid_time_window_format",
      message: "Time window must be an object",
      messageJa: "時間窓はオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;
  const window: TimeWindow = {};

  if (rec.dayOfWeek !== undefined) {
    if (!Array.isArray(rec.dayOfWeek)) {
      errors.push({
        ruleIndex: index,
        field: `${fieldName}[${windowIndex}].dayOfWeek`,
        code: "invalid_day_of_week",
        message: "dayOfWeek must be an array of numbers (0-6)",
        messageJa: "dayOfWeek は 0〜6 の数値配列でなければなりません",
      });
    } else {
      const days = rec.dayOfWeek.filter(
        (d): d is number => typeof d === "number" && d >= 0 && d <= 6
      );
      if (days.length > 0) {
        window.dayOfWeek = days;
      }
    }
  }

  if (typeof rec.startTime === "string" && rec.startTime.trim()) {
    window.startTime = rec.startTime.trim();
  }
  if (typeof rec.endTime === "string" && rec.endTime.trim()) {
    window.endTime = rec.endTime.trim();
  }
  if (typeof rec.startDate === "string" && rec.startDate.trim()) {
    window.startDate = rec.startDate.trim();
  }
  if (typeof rec.endDate === "string" && rec.endDate.trim()) {
    window.endDate = rec.endDate.trim();
  }
  if (typeof rec.reason === "string" && rec.reason.trim()) {
    window.reason = rec.reason.trim();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, window };
}

function validateOnlinePack(
  raw: unknown,
  index: number
): { ok: true; pack: OnlineMeetingPack } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: "onlinePack",
      code: "invalid_online_pack_format",
      message: "onlinePack must be an object",
      messageJa: "オンライン設定はオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;

  const pack: OnlineMeetingPack = {
    enabled: rec.enabled === true,
    videoToolAllowlist: [],
  };

  if (typeof rec.calendarTarget === "string" && rec.calendarTarget.trim()) {
    pack.calendarTarget = rec.calendarTarget.trim();
  }

  if (Array.isArray(rec.videoToolAllowlist)) {
    const allowlist: OnlineVideoToolEntry[] = [];
    for (const item of rec.videoToolAllowlist) {
      if (typeof item === "string" && item.trim()) {
        allowlist.push({ tool: item.trim() });
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const entry = item as Record<string, unknown>;
        if (typeof entry.tool === "string" && entry.tool.trim()) {
          allowlist.push({
            tool: entry.tool.trim(),
            isDefault: entry.isDefault === true,
          });
        }
      }
    }
    pack.videoToolAllowlist = allowlist;

    const defaultTool = allowlist.find((e) => e.isDefault);
    if (defaultTool) {
      pack.defaultVideoTool = defaultTool.tool;
    }
  }

  if (typeof rec.defaultVideoTool === "string" && rec.defaultVideoTool.trim()) {
    pack.defaultVideoTool = rec.defaultVideoTool.trim();
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, pack };
}

export function validateSchedulingRule(
  raw: unknown,
  index: number
): { ok: true; rule: SchedulingRule } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({
      ruleIndex: index,
      field: "rule",
      code: "invalid_rule_format",
      message: "Rule must be an object",
      messageJa: "ルールはオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = raw as Record<string, unknown>;
  errors.push(...collectUnknownFieldErrors(rec, RULE_ALLOWED_KEYS, "rule", index));

  const id =
    typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : generateRuleId();

  const rule: SchedulingRule = {
    id,
    confirmAutomation: "always_human",
  };

  if (typeof rec.priority === "number") {
    rule.priority = rec.priority;
  }

  if (rec.locationAffinity !== undefined) {
    if (!isLocationAffinity(rec.locationAffinity)) {
      errors.push({
        ruleIndex: index,
        field: "locationAffinity",
        code: "invalid_location_affinity",
        message: `locationAffinity must be one of: ${LOCATION_AFFINITY_VALUES.join(", ")}`,
        messageJa: `場所親和は ${LOCATION_AFFINITY_VALUES.join(" / ")} のいずれかです`,
      });
    } else {
      rule.locationAffinity = rec.locationAffinity;
    }
  }

  if (rec.travelBufferMinutes !== undefined) {
    const buffer = Number(rec.travelBufferMinutes);
    if (!Number.isFinite(buffer) || buffer < 0) {
      errors.push({
        ruleIndex: index,
        field: "travelBufferMinutes",
        code: "invalid_travel_buffer",
        message: "travelBufferMinutes must be a non-negative number",
        messageJa: "移動バッファは 0 以上の数値でなければなりません",
      });
    } else {
      rule.travelBufferMinutes = buffer;
    }
  }

  if (rec.onlinePack !== undefined) {
    const packResult = validateOnlinePack(rec.onlinePack, index);
    if (packResult.ok) {
      rule.onlinePack = packResult.pack;
    } else {
      errors.push(...packResult.errors);
    }
  }

  if (Array.isArray(rec.hardBlackout)) {
    const blackouts: TimeWindow[] = [];
    for (let i = 0; i < rec.hardBlackout.length; i++) {
      const result = validateTimeWindow(rec.hardBlackout[i], index, "hardBlackout", i);
      if (result.ok) {
        blackouts.push(result.window);
      } else {
        errors.push(...result.errors);
      }
    }
    if (blackouts.length > 0) {
      rule.hardBlackout = blackouts;
    }
  }

  if (Array.isArray(rec.softPrefer)) {
    const prefers: TimeWindow[] = [];
    for (let i = 0; i < rec.softPrefer.length; i++) {
      const result = validateTimeWindow(rec.softPrefer[i], index, "softPrefer", i);
      if (result.ok) {
        prefers.push(result.window);
      } else {
        errors.push(...result.errors);
      }
    }
    if (prefers.length > 0) {
      rule.softPrefer = prefers;
    }
  }

  if (rec.costCapJpy !== undefined) {
    const cap = Number(rec.costCapJpy);
    if (!Number.isFinite(cap) || cap < 0) {
      errors.push({
        ruleIndex: index,
        field: "costCapJpy",
        code: "invalid_cost_cap",
        message: "costCapJpy must be a non-negative number",
        messageJa: "コスト上限は 0 以上の数値でなければなりません",
      });
    } else {
      rule.costCapJpy = cap;
    }
  }

  if (!isConfirmAutomation(rec.confirmAutomation)) {
    errors.push({
      ruleIndex: index,
      field: "confirmAutomation",
      code: "invalid_confirm_automation",
      message: `confirmAutomation must be one of: ${CONFIRM_AUTOMATION_VALUES.join(", ")}`,
      messageJa: `確定の自動化レベルは ${CONFIRM_AUTOMATION_VALUES.join(" / ")} のいずれかです`,
    });
  } else {
    rule.confirmAutomation = rec.confirmAutomation;
  }

  if (rec.calendarSources !== undefined) {
    const sourcesResult = validateCalendarSources(rec.calendarSources, index);
    if (sourcesResult.ok) {
      rule.calendarSources = sourcesResult.sources;
    } else {
      errors.push(...sourcesResult.errors);
    }
  }

  if (rec.meetingMode !== undefined) {
    const meetingModeResult = validateMeetingMode(rec.meetingMode, index);
    if (meetingModeResult.ok) {
      rule.meetingMode = meetingModeResult.meetingMode;
    } else {
      errors.push(...meetingModeResult.errors);
    }
  }

  if (rec.areaPolicy !== undefined) {
    const areaResult = validateAreaPolicy(rec.areaPolicy, index);
    if (areaResult.ok) {
      rule.areaPolicy = areaResult.areaPolicy;
    } else {
      errors.push(...areaResult.errors);
    }
  }

  if (rec.travelFeasibility !== undefined) {
    const travelResult = validateTravelFeasibility(rec.travelFeasibility, index);
    if (travelResult.ok) {
      rule.travelFeasibility = travelResult.travelFeasibility;
    } else {
      errors.push(...travelResult.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, rule };
}

export interface ValidateSchedulingPolicyOptions {
  requireHighRiskConsent?: boolean;
  existingConsent?: { at: string; by: string } | null;
}

export function validateSchedulingPolicy(
  input: unknown,
  options: ValidateSchedulingPolicyOptions = {}
): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      field: "policy",
      code: "invalid_policy_format",
      message: "Policy must be an object",
      messageJa: "ポリシーはオブジェクトでなければなりません",
    });
    return { ok: false, errors };
  }

  const rec = input as Record<string, unknown>;
  errors.push(...collectUnknownFieldErrors(rec, POLICY_ALLOWED_KEYS, "policy"));

  const policyId =
    typeof rec.policyId === "string" && rec.policyId.trim()
      ? rec.policyId.trim()
      : generatePolicyId();

  const policyName =
    typeof rec.policyName === "string" && rec.policyName.trim()
      ? rec.policyName.trim()
      : "デフォルトスケジューリングポリシー";

  if (!Array.isArray(rec.rules)) {
    errors.push({
      field: "rules",
      code: "rules_required",
      message: "rules array is required",
      messageJa: "ルール配列が必要です",
    });
    return { ok: false, errors };
  }

  if (rec.rules.length === 0) {
    errors.push({
      field: "rules",
      code: "rules_empty",
      message: "At least one rule is required",
      messageJa: "ルールは少なくとも1つ必要です",
    });
    return { ok: false, errors };
  }

  const validatedRules: SchedulingRule[] = [];
  let hasHighRiskRule = false;

  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateSchedulingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
      if (isHighRiskAutomation(result.rule.confirmAutomation)) {
        hasHighRiskRule = true;
      }
    } else {
      errors.push(...result.errors);
    }
  }

  if (hasHighRiskRule && options.requireHighRiskConsent) {
    const hasConsent =
      options.existingConsent ||
      (typeof rec.highRiskConsentAt === "string" &&
        typeof rec.highRiskConsentBy === "string");

    if (!hasConsent) {
      errors.push({
        field: "highRiskConsent",
        code: "high_risk_consent_required",
        message:
          "High-risk automation levels (risk_based, conditional, full_auto) require explicit tenant consent",
        messageJa:
          "高リスク自動化レベル（risk_based, conditional, full_auto）にはテナントの明示的な承諾が必要です",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  let regionDictionary: OrgRegionDictionary | undefined;
  if (rec.regionDictionary !== undefined) {
    const dictResult = validateRegionDictionary(rec.regionDictionary);
    if (dictResult.ok) {
      regionDictionary = dictResult.dictionary;
    } else {
      errors.push(...dictResult.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const policy: OrgSchedulingPolicy = {
    version: 1,
    policyId,
    policyName,
    rules: validatedRules,
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  if (regionDictionary) {
    policy.regionDictionary = regionDictionary;
  }

  if (
    typeof rec.highRiskConsentAt === "string" &&
    typeof rec.highRiskConsentBy === "string"
  ) {
    policy.highRiskConsentAt = rec.highRiskConsentAt;
    policy.highRiskConsentBy = rec.highRiskConsentBy;
  } else if (options.existingConsent) {
    policy.highRiskConsentAt = options.existingConsent.at;
    policy.highRiskConsentBy = options.existingConsent.by;
  }

  return { ok: true, policy };
}

export const DEFAULT_SCHEDULING_RULE: SchedulingRule = {
  id: "spr_default",
  locationAffinity: "any",
  confirmAutomation: "always_human",
};

export function defaultSchedulingPolicy(): OrgSchedulingPolicy {
  return {
    version: 1,
    policyId: generatePolicyId(),
    policyName: "デフォルトスケジューリングポリシー",
    rules: [{ ...DEFAULT_SCHEDULING_RULE, id: generateRuleId() }],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

export function normalizeSchedulingPolicy(value: unknown): OrgSchedulingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultSchedulingPolicy();
  }
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.rules) || rec.rules.length === 0) {
    return defaultSchedulingPolicy();
  }

  const validatedRules: SchedulingRule[] = [];
  for (let i = 0; i < rec.rules.length; i++) {
    const result = validateSchedulingRule(rec.rules[i], i);
    if (result.ok) {
      validatedRules.push(result.rule);
    }
  }

  if (validatedRules.length === 0) {
    return defaultSchedulingPolicy();
  }

  let regionDictionary: OrgRegionDictionary | undefined;
  if (rec.regionDictionary && typeof rec.regionDictionary === "object") {
    const dictResult = validateRegionDictionary(rec.regionDictionary);
    if (dictResult.ok) {
      regionDictionary = dictResult.dictionary;
    }
  }

  const policy: OrgSchedulingPolicy = {
    version: 1,
    policyId:
      typeof rec.policyId === "string" && rec.policyId.trim()
        ? rec.policyId.trim()
        : generatePolicyId(),
    policyName:
      typeof rec.policyName === "string" && rec.policyName.trim()
        ? rec.policyName.trim()
        : "スケジューリングポリシー",
    rules: validatedRules,
    highRiskConsentAt:
      typeof rec.highRiskConsentAt === "string" ? rec.highRiskConsentAt : undefined,
    highRiskConsentBy:
      typeof rec.highRiskConsentBy === "string" ? rec.highRiskConsentBy : undefined,
    updatedAt:
      typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
    updatedBy: "admin_mcp",
  };

  if (regionDictionary) {
    policy.regionDictionary = regionDictionary;
  }

  return policy;
}

export function isDefaultSchedulingPolicy(policy: OrgSchedulingPolicy): boolean {
  if (policy.rules.length !== 1) return false;
  const rule = policy.rules[0];
  return (
    rule.confirmAutomation === "always_human" &&
    (rule.locationAffinity === "any" || rule.locationAffinity === undefined) &&
    rule.travelBufferMinutes === undefined &&
    rule.onlinePack === undefined &&
    rule.hardBlackout === undefined &&
    rule.softPrefer === undefined &&
    rule.costCapJpy === undefined &&
    rule.calendarSources === undefined &&
    rule.meetingMode === undefined &&
    rule.areaPolicy === undefined &&
    rule.travelFeasibility === undefined &&
    policy.regionDictionary === undefined
  );
}

export function policyHasHighRiskAutomation(policy: OrgSchedulingPolicy): boolean {
  return policy.rules.some((r) => isHighRiskAutomation(r.confirmAutomation));
}

export function summarizeSchedulingPolicyJa(policy: OrgSchedulingPolicy): string {
  if (policy.rules.length === 0) return "ルールなし";
  if (isDefaultSchedulingPolicy(policy)) {
    return "デフォルト: 日程確定は常に人間承認 (always_human)";
  }

  const parts: string[] = [];
  for (const rule of policy.rules) {
    const locationJa =
      rule.locationAffinity === "office_first"
        ? "オフィス優先"
        : rule.locationAffinity === "remote_first"
          ? "リモート優先"
          : rule.locationAffinity === "hybrid"
            ? "ハイブリッド"
            : "場所不問";
    const automationJa =
      rule.confirmAutomation === "always_human"
        ? "常に人間承認"
        : rule.confirmAutomation === "risk_based"
          ? "リスクベース"
          : rule.confirmAutomation === "conditional"
            ? "条件付き自動"
            : "完全自動";
    const bufferJa = rule.travelBufferMinutes
      ? `移動${rule.travelBufferMinutes}分`
      : "";
    const calendarJa = rule.calendarSources
      ? `複数カレンダー(${rule.calendarSources.ids.length}件)`
      : "";
    const meetingModeJa = rule.meetingMode
      ? rule.meetingMode.strategy === "title_tag"
        ? `オンラインタグ${rule.meetingMode.onlineTitleTags?.length ? `(${rule.meetingMode.onlineTitleTags.join("/")})` : ""}`
        : "明示モード"
      : "";
    const areaJa = rule.areaPolicy?.allowRegions?.length
      ? `地域許可(${rule.areaPolicy.allowRegions.join("/")})`
      : rule.areaPolicy?.denyRegions?.length
        ? `地域拒否(${rule.areaPolicy.denyRegions.join("/")})`
        : "";
    const parts2 = [locationJa, automationJa, bufferJa, calendarJa, meetingModeJa, areaJa].filter(
      Boolean
    );
    parts.push(parts2.join(" / "));
  }
  return parts.join(" → ");
}

export function nextStepSchedulingPolicyJa(policy: OrgSchedulingPolicy): string {
  if (isDefaultSchedulingPolicy(policy)) {
    return "デフォルトの安全設定です。日程確定は常に人間承認が必要です。自動化レベルを変更するにはルールを追加してください。";
  }

  if (policyHasHighRiskAutomation(policy)) {
    if (!policy.highRiskConsentAt) {
      return "高リスク自動化が設定されていますが、テナント承諾が未記録です。schedulingPolicy.patch で highRiskConsentAt/By を設定してください。";
    }
    return `高リスク自動化が有効です（承諾: ${policy.highRiskConsentBy} / ${policy.highRiskConsentAt}）。運用に注意してください。`;
  }

  return "スケジューリングポリシー設定完了。calendar.propose 呼び出し時に適用されます。";
}
