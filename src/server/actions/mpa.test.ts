import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
const { ensureRenderPhaseAfterAction } = await import("./mpa");

afterEach(() => {
  vi.unstubAllEnvs();
  revalidatePath.mockClear();
});

describe("ensureRenderPhaseAfterAction (D14 dev-only workaround)", () => {
  it("revalidates in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    ensureRenderPhaseAfterAction("/admin/projects", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/projects", "layout");
  });

  it("is a no-op in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    ensureRenderPhaseAfterAction("/admin/projects", "layout");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
