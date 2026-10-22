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
  it("only fixtures and the owner-approved web research source are approved; other candidates have no automated access", () => {
    for (const s of SOURCE_REGISTRY.filter((s) => s.type !== "fixture" && s.id !== "anthropic-web-search")) {
      expect(s.status).toBe("proposed");
      expect(["link_out_only", "manual"]).toContain(s.accessMethod);
      expect(s.termsReviewedAt).toBeNull();
      expect(s.rateLimitPerMinute).toBe(0);
      expect(s.allowedEnvironments).toEqual([]);
    }
  });
  it("web research source is approved (D16) for production only", () => {
    const w = getSource("anthropic-web-search")!;
    expect(w.status).toBe("approved");
    expect(w.accessMethod).toBe("api");
    expect(w.termsReviewedAt).toBe("2026-10-22");
    expect(isRunnable(w, "production")).toBe(true);
    for (const env of ["test", "development"] as const) expect(isRunnable(w, env)).toBe(false);
  });
  it("K-RERA is link-out only and never runnable (robots-disallowed, D16)", () => {
    const k = getSource("k-rera")!;
    expect(k.accessMethod).toBe("link_out_only");
    for (const env of ["test", "development", "production"] as const) expect(isRunnable(k, env)).toBe(false);
  });
  it("research sources: the fixture runs only in test/dev; the real one never in test", () => {
    const fixture = getSource("sample-web-research")!;
    expect(isRunnable(fixture, "test")).toBe(true);
    expect(isRunnable(fixture, "production")).toBe(false);
    const real = getSource("anthropic-web-search")!;
    expect(real.accessMethod).toBe("api");
    expect(isRunnable(real, "test")).toBe(false);
    // Even once approved for production, test stays blocked unless explicitly listed.
    expect(isRunnable({ ...real, status: "approved", allowedEnvironments: ["production"] }, "test")).toBe(false);
  });
});
