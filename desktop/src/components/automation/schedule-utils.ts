import type { AutomationFrequency } from "./types";

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function localTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function parseLocalMinute(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00`);
  if (Number.isNaN(value.getTime())) return null;
  // Date normalizes impossible values such as 2026-02-31; reject them instead.
  if (localDate(value) !== date || localTime(value) !== time) return null;
  return value;
}

/** Give a newly-created one-off task a future value instead of today's stale 09:00. */
export function nextOnceFrequency(now = new Date()): AutomationFrequency {
  const next = new Date(now.getTime() + 5 * 60_000);
  next.setSeconds(0, 0);
  return { type: "once", date: localDate(next), time: localTime(next) };
}

export function automationScheduleError(
  frequency: AutomationFrequency,
  options: { now?: Date; rangeStart?: string; rangeEnd?: string } = {},
): string {
  const rangeStart = String(options.rangeStart ?? "").trim();
  const rangeEnd = String(options.rangeEnd ?? "").trim();
  if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
    return "生效结束日期不能早于开始日期。";
  }

  if (frequency.type !== "once") return "";
  const target = parseLocalMinute(frequency.date, frequency.time);
  if (!target) return "请选择有效的单次执行日期和时间。";
  if (target.getTime() <= (options.now ?? new Date()).getTime()) {
    return "单次执行时间必须晚于当前时间。";
  }
  return "";
}
