import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { clientIpFromForwardedFor } = await import("./client-ip");
const { trustedProxyHops } = await import("./env");

describe("clientIpFromForwardedFor", () => {
  it("uses the last entry with 1 trusted hop", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 1)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("198.51.100.1, 203.0.113.7", 1)).toBe("203.0.113.7");
  });

  it("uses second-from-last with 2 trusted hops (Cloud Run behind Google LB)", () => {
    expect(clientIpFromForwardedFor("203.0.113.7, 34.120.0.1", 2)).toBe("203.0.113.7");
  });

  it("ignores spoofed leading entries supplied by the client", () => {
    const spoofed = "1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7, 34.120.0.1";
    expect(clientIpFromForwardedFor(spoofed, 2)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("9.9.9.9, 203.0.113.7", 1)).toBe("203.0.113.7");
  });

  it("falls back to the left-most entry when there are fewer entries than hops", () => {
    expect(clientIpFromForwardedFor("203.0.113.7", 2)).toBe("203.0.113.7");
  });

  it("returns null only when the header is absent or empty; normalises spacing/case", () => {
    expect(clientIpFromForwardedFor(null, 1)).toBeNull();
    expect(clientIpFromForwardedFor(undefined, 1)).toBeNull();
    expect(clientIpFromForwardedFor(" , ", 1)).toBeNull();
    expect(clientIpFromForwardedFor("2001:DB8::1 ,  ", 1)).toBe("2001:db8::1");
    expect(clientIpFromForwardedFor("203.0.113.7", 0)).toBe("203.0.113.7"); // invalid hops → 1
  });

  it("reads TRUSTED_PROXY_HOPS (default 1, integer >= 1)", () => {
    expect(trustedProxyHops({} as NodeJS.ProcessEnv)).toBe(1);
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: "2" } as unknown as NodeJS.ProcessEnv)).toBe(2);
    expect(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: "0" } as unknown as NodeJS.ProcessEnv)).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});
