import { describe, expect, it } from "vitest";
import { SOURCE_REGISTRY, assertRunnable, getSource, isRunnable } from "./registry";

describe("source registry gating", () => {
  it("refuses proposed sources in every environment", () => {
    const proposed = SOURCE_REGISTRY.filter((s) => s.status === "proposed");
    expect(proposed.length).toBeGreaterThan(0);
    for (const s of proposed) for (const env of ["test", "development", "production"] as const)
      expect(() => assertRunnable(s, env)).toThrow(/not runnable/);
  });
  it("allows fixtures in test/dev but refuses them in production", () => {
    const f = getSource("sample-feed")!;
    expect(() => assertRunnable(f, "test")).not.toThrow();
    expect(isRunnable(f, "development")).toBe(true);
    expect(() => assertRunnable(f, "production")).toThrow(/production/);
  });
  it("refuses an approved source outside its allowed environments", () => {
    const s = { ...getSource("sample-feed")!, type: "partner_feed" as const, allowedEnvironments: ["test" as const] };
    expect(isRunnable(s, "production")).toBe(false);
  });
  it("only fixtures are approved; real candidates have no ToS review and no automated access", () => {
    for (const s of SOURCE_REGISTRY.filter((s) => s.type !== "fixture")) {
      expect(s.status).toBe("proposed");
      expect(["link_out_only", "manual"]).toContain(s.accessMethod);
      expect(s.termsReviewedAt).toBeNull();
      expect(s.rateLimitPerMinute).toBe(0);
      expect(s.allowedEnvironments).toEqual([]);
    }
  });
});
