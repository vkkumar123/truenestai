import { describe, expect, it } from "vitest";
import { freshnessState } from "./freshness";

const now = new Date("2026-10-21T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe("freshnessState", () => {
  it("never_checked for null/undefined/empty", () => {
    expect(freshnessState(null, now)).toBe("never_checked");
    expect(freshnessState(undefined, now)).toBe("never_checked");
    expect(freshnessState("", now)).toBe("never_checked");
  });

  it("uses 30/90 day defaults with inclusive bounds", () => {
    expect(freshnessState(daysAgo(0), now)).toBe("fresh");
    expect(freshnessState(daysAgo(30), now)).toBe("fresh");
    expect(freshnessState(daysAgo(31), now)).toBe("aging");
    expect(freshnessState(daysAgo(90), now)).toBe("aging");
    expect(freshnessState(daysAgo(91), now)).toBe("stale");
  });

  it("accepts Date input and treats future timestamps as fresh", () => {
    expect(freshnessState(new Date(daysAgo(10)), now)).toBe("fresh");
    expect(freshnessState(daysAgo(-5), now)).toBe("fresh");
  });

  it("supports custom thresholds", () => {
    const t = { freshDays: 7, staleDays: 14 };
    expect(freshnessState(daysAgo(8), now, t)).toBe("aging");
    expect(freshnessState(daysAgo(15), now, t)).toBe("stale");
  });

  it("rejects invalid input", () => {
    expect(() => freshnessState("not-a-date", now)).toThrow(TypeError);
    expect(() => freshnessState(daysAgo(1), now, { freshDays: 10, staleDays: 5 })).toThrow(RangeError);
  });
});
