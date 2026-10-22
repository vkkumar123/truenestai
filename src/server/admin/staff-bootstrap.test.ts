import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { createStaff, parseCreateStaffArgs } = await import("./staff-bootstrap");

describe("parseCreateStaffArgs", () => {
  it("accepts --flag value and --flag=value forms, normalising the email", () => {
    expect(parseCreateStaffArgs(["--email", " Owner@Example.com ", "--role=admin", "--name", "Owner One", "--dry-run"])).toEqual({
      ok: true,
      args: { email: "owner@example.com", role: "admin", displayName: "Owner One", dryRun: true, redirectTo: null },
    });
    expect(parseCreateStaffArgs(["--email=a@example.org", "--role", "advisor", "--redirect-to", "https://example.com/admin/login"]))
      .toMatchObject({ ok: true, args: { role: "advisor", redirectTo: "https://example.com/admin/login", displayName: null } });
  });

  it("rejects missing, invalid, unknown, duplicate and password arguments", () => {
    const bad: string[][] = [
      [],
      ["--role", "admin"],
      ["--email", "x@example.com"],
      ["--email", "not-an-email", "--role", "admin"],
      ["--email", "x@example.com", "--role", "owner"],
      ["--email", "x@example.com", "--role", "admin", "--force"],
      ["--email", "x@example.com", "--email", "y@example.com", "--role", "admin"],
      ["--email", "x@example.com", "--role", "admin", "--password", "hunter2"],
      ["--email", "--role", "admin"],
      ["--email", "x@example.com", "--role", "admin", "--name", "bad\u0007name"],
      ["--email", "x@example.com", "--role", "admin", "--redirect-to", "javascript:alert(1)"],
      ["stray"],
    ];
    for (const argv of bad) expect(parseCreateStaffArgs(argv), argv.join(" ")).toMatchObject({ ok: false });
    const pw = parseCreateStaffArgs(["--email", "x@example.com", "--role", "admin", "--password=hunter2"]);
    expect(pw.ok).toBe(false);
    if (!pw.ok) expect(pw.error).not.toMatch(/hunter2/);
  });
});

describe("createStaff (fake admin API)", () => {
  function fakeApi(existing: Record<string, string> = {}, profiles: Record<string, { role: "admin" | "advisor"; displayName: string | null }> = {}) {
    const calls: string[] = [];
    return {
      calls,
      profiles,
      api: {
        findUserIdByEmail: async (e: string) => existing[e] ?? null,
        inviteUser: async (e: string) => {
          calls.push(`invite:${e}`);
          existing[e] = "new-user-id";
          return "new-user-id";
        },
        getStaffProfile: async (id: string) => profiles[id] ?? null,
        upsertStaffProfile: async (p: { userId: string; role: "admin" | "advisor"; displayName: string | null }) => {
          calls.push(`upsert:${p.userId}:${p.role}`);
          profiles[p.userId] = { role: p.role, displayName: p.displayName };
        },
      },
    };
  }
  const args = { email: "owner@example.com", role: "admin" as const, displayName: "Owner", dryRun: false, redirectTo: null };

  it("invites a missing user, creates the profile, and is idempotent on re-run", async () => {
    const f = fakeApi();
    expect(await createStaff(args, f.api)).toEqual({ userId: "new-user-id", userAction: "invited", profileAction: "created", previousRole: null });
    expect(await createStaff(args, f.api)).toMatchObject({ userAction: "existing", profileAction: "unchanged" });
    expect(f.calls).toEqual(["invite:owner@example.com", "upsert:new-user-id:admin"]);
  });

  it("updates the role of an existing staff member and keeps the display name when none is given", async () => {
    const f = fakeApi({ "owner@example.com": "u1" }, { u1: { role: "advisor", displayName: "Kept" } });
    expect(await createStaff({ ...args, displayName: null }, f.api)).toMatchObject({ profileAction: "updated", previousRole: "advisor" });
    expect(f.profiles.u1).toEqual({ role: "admin", displayName: "Kept" });
  });

  it("dry run performs no writes", async () => {
    const f = fakeApi();
    expect(await createStaff({ ...args, dryRun: true }, f.api)).toMatchObject({ userAction: "would_invite", profileAction: "would_create" });
    const g = fakeApi({ "owner@example.com": "u1" });
    expect(await createStaff({ ...args, dryRun: true }, g.api)).toMatchObject({ userAction: "existing", profileAction: "would_create" });
    expect([...f.calls, ...g.calls]).toEqual([]);
  });
});
