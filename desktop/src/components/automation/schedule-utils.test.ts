import { describe, expect, it } from "vitest";
import { automationScheduleError, nextOnceFrequency } from "./schedule-utils";

describe("automation schedule validation", () => {
  const now = new Date("2026-08-27T14:54:00");

  it("defaults a one-off task to a future local time", () => {
    expect(nextOnceFrequency(now)).toEqual({
      type: "once",
      date: "2026-08-27",
      time: "14:59",
    });
  });

  it("rejects a one-off task whose time has already passed", () => {
    expect(
      automationScheduleError(
        { type: "once", date: "2026-08-27", time: "09:00" },
        { now },
      ),
    ).toBe("单次执行时间必须晚于当前时间。");
  });

  it("accepts a future one-off task", () => {
    expect(
      automationScheduleError(
        { type: "once", date: "2026-08-27", time: "15:00" },
        { now },
      ),
    ).toBe("");
  });

  it("rejects an impossible calendar date", () => {
    expect(
      automationScheduleError(
        { type: "once", date: "2026-02-31", time: "15:00" },
        { now },
      ),
    ).toBe("请选择有效的单次执行日期和时间。");
  });

  it("rejects a reversed effective date range", () => {
    expect(
      automationScheduleError(
        { type: "daily", time: "09:00", days: [1, 2, 3, 4, 5] },
        { rangeStart: "2026-09-02", rangeEnd: "2026-09-01" },
      ),
    ).toBe("生效结束日期不能早于开始日期。");
  });
});
