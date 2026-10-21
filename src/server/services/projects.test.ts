import { describe, expect, it, vi } from "vitest";
import type { ExternalListing } from "@/domain/types";

vi.mock("server-only", () => ({}));

const { createFixtureRepositories, SAMPLE_PROJECTS } = await import("../repositories/fixture");
const { getPublishedProject, getRequestSubject } = await import("./projects");

const UNPUBLISHED = SAMPLE_PROJECTS.find((p) => !p.published)!;
const PUBLISHED = SAMPLE_PROJECTS.find((p) => p.published)!;

describe("getPublishedProject", () => {
  it("returns a published project by slug", async () => {
    const p = await getPublishedProject(PUBLISHED.slug, { repos: createFixtureRepositories() });
    expect(p?.id).toBe(PUBLISHED.id);
  });

  it("returns null for unpublished, missing or malformed slugs", async () => {
    const repos = createFixtureRepositories();
    expect(await getPublishedProject(UNPUBLISHED.slug, { repos })).toBeNull();
    expect(await getPublishedProject("no-such-project", { repos })).toBeNull();
    expect(await getPublishedProject("../etc/passwd", { repos })).toBeNull();
  });
});

describe("getRequestSubject", () => {
  const listing: ExternalListing = {
    id: "sample-feed:SAMPLE-X",
    lane: "external",
    sourceId: "sample-feed",
    sourceRecordId: "SAMPLE-X",
    canonicalUrl: "https://example.com/sample/x",
    title: "SAMPLE X (fictional)",
    developerName: null,
    localityId: null,
    location: null,
    priceText: null,
    discoveredAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: null,
    limitations: ["Not verified by TrueNest"],
    matchedProjectId: null,
    isSample: true,
  };

  it("summarises a published project minimally", async () => {
    const s = await getRequestSubject({ projectId: PUBLISHED.id }, { repos: createFixtureRepositories() });
    expect(s).toEqual({ kind: "project", id: PUBLISHED.id, name: PUBLISHED.name, isSample: true });
  });

  it("returns null for an unpublished or unknown project", async () => {
    const repos = createFixtureRepositories();
    expect(await getRequestSubject({ projectId: UNPUBLISHED.id }, { repos })).toBeNull();
    expect(await getRequestSubject({ projectId: "nope" }, { repos })).toBeNull();
    expect(await getRequestSubject({}, { repos })).toBeNull();
  });

  it("summarises a stored external listing", async () => {
    const repos = createFixtureRepositories();
    expect(await getRequestSubject({ externalListingId: listing.id }, { repos })).toBeNull();
    await repos.externalListings.upsertMany([listing]);
    expect(await getRequestSubject({ externalListingId: listing.id }, { repos })).toEqual({
      kind: "external_listing",
      id: listing.id,
      name: listing.title,
      isSample: true,
    });
  });
});
