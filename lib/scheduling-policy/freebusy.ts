/**
 * A1 v2 multi-calendar free/busy merge.
 * union_busy: slot is dropped if busy on ANY configured calendar.
 */
import type { CalendarSources } from "@/lib/types";
import type { FreebusySlot } from "./apply";

export type BusyInterval = {
  start: string;
  end: string;
};

function parseDate(str: string): Date {
  return new Date(str);
}

function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Returns true when slot overlaps any busy interval on any configured calendar.
 */
export function isSlotBusyOnUnionCalendars(
  slot: FreebusySlot,
  calendarSources: CalendarSources,
  busyByCalendar: Record<string, BusyInterval[]>
): boolean {
  const slotStart = parseDate(slot.start);
  const slotEnd = parseDate(slot.end);

  for (const calendarId of calendarSources.ids) {
    const busyIntervals = busyByCalendar[calendarId] ?? [];
    for (const busy of busyIntervals) {
      const busyStart = parseDate(busy.start);
      const busyEnd = parseDate(busy.end);
      if (intervalsOverlap(slotStart, slotEnd, busyStart, busyEnd)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Filter candidate slots using union_busy across configured calendar ids.
 */
export function filterSlotsByUnionBusy(
  slots: FreebusySlot[],
  calendarSources: CalendarSources,
  busyByCalendar: Record<string, BusyInterval[]>
): {
  kept: FreebusySlot[];
  dropped: FreebusySlot[];
  calendarSourcesUsed: string[];
} {
  const kept: FreebusySlot[] = [];
  const dropped: FreebusySlot[] = [];

  for (const slot of slots) {
    if (isSlotBusyOnUnionCalendars(slot, calendarSources, busyByCalendar)) {
      dropped.push(slot);
    } else {
      kept.push(slot);
    }
  }

  return {
    kept,
    dropped,
    calendarSourcesUsed: calendarSources.ids,
  };
}

/**
 * Collect calendarSources from rules (first rule with calendarSources wins).
 */
export function resolveCalendarSources(
  rules: Array<{ calendarSources?: CalendarSources }>
): CalendarSources | null {
  for (const rule of rules) {
    if (rule.calendarSources) {
      return rule.calendarSources;
    }
  }
  return null;
}
