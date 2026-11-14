import type { AutomationSchedule } from "../contracts/index.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

/** The wall-clock date and minute shown in `timeZone` at a UTC instant. */
function wallTime(utcMs: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

function wallMs(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/**
 * Every UTC instant whose local wall time in `timeZone` equals `wall`, earliest first.
 * A daylight-saving gap yields none; a repeated hour yields two.
 */
export function localInstants(wall: Wall, timeZone: string): number[] {
  const target = wallMs(wall);
  const offsets = new Set<number>();
  for (const probe of [target - DAY, target, target + DAY]) {
    const start = Math.floor(probe / MINUTE) * MINUTE;
    offsets.add(wallMs(wallTime(start, timeZone)) - start);
  }
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = target - offset;
    if (wallMs(wallTime(candidate, timeZone)) === target) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The first scheduled occurrence strictly after `after`.
 *
 * Intervals are anchored, so a late or long run never shifts later occurrences. Local times
 * that do not exist on a daylight-saving transition day are skipped; a repeated local time
 * runs once, at its first occurrence.
 */
export function nextOccurrence(schedule: AutomationSchedule, after: Date): Date {
  const now = after.getTime();
  if (schedule.type === "interval") {
    const every = schedule.everyMinutes * MINUTE;
    const anchor = Date.parse(schedule.anchor);
    if (now < anchor) return new Date(anchor);
    return new Date(anchor + (Math.floor((now - anchor) / every) + 1) * every);
  }
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const today = wallTime(now, schedule.timeZone);
  const days = schedule.type === "weekly" ? new Set(schedule.days) : undefined;
  // A weekly schedule recurs within eight days; a few spare days cover transition gaps.
  for (let offset = 0; offset < 16; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (days && !days.has(date.getUTCDay())) continue;
    const [first] = localInstants(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour,
        minute,
      },
      schedule.timeZone,
    );
    if (first !== undefined && first > now) return new Date(first);
  }
  throw new Error("The schedule has no upcoming occurrence");
}

/** The next `count` occurrences, for previews before saving. */
export function upcomingOccurrences(
  schedule: AutomationSchedule,
  after: Date,
  count: number,
): Date[] {
  const result: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index++) {
    cursor = nextOccurrence(schedule, cursor);
    result.push(cursor);
  }
  return result;
}

/** How late a due occurrence may start before it counts as missed and is skipped. */
const MISSED_GRACE_MS = 2 * MINUTE;

export type DueDecision =
  | { type: "wait"; nextRunAt: Date }
  | { type: "run"; scheduledFor: Date; nextRunAt: Date }
  | { type: "missed"; scheduledFor: Date; nextRunAt: Date };

/**
 * Decides what the scheduler does with a saved next occurrence at `now`.
 *
 * Occurrences missed by more than the grace period (sleep, logout, downtime) are skipped,
 * without catch-up runs. A clock moved backwards pulls the saved time back to the real next
 * occurrence, so a schedule never stalls waiting for a future that no longer applies. It never
 * pulls back to or before `claimedThrough`, the latest occurrence already claimed, so a clock
 * correction cannot replay completed or uncertain work.
 */
export function dueDecision(
  schedule: AutomationSchedule,
  savedNextRunAt: Date | null,
  now: Date,
  claimedThrough: Date | null = null,
): DueDecision {
  const upcoming = nextOccurrence(
    schedule,
    claimedThrough && claimedThrough > now ? claimedThrough : now,
  );
  if (
    savedNextRunAt === null ||
    savedNextRunAt.getTime() > upcoming.getTime() ||
    (claimedThrough !== null && savedNextRunAt.getTime() <= claimedThrough.getTime())
  )
    return { type: "wait", nextRunAt: upcoming };
  if (savedNextRunAt.getTime() > now.getTime()) return { type: "wait", nextRunAt: savedNextRunAt };
  const late = now.getTime() - savedNextRunAt.getTime();
  return late > MISSED_GRACE_MS
    ? { type: "missed", scheduledFor: savedNextRunAt, nextRunAt: upcoming }
    : { type: "run", scheduledFor: savedNextRunAt, nextRunAt: upcoming };
}
