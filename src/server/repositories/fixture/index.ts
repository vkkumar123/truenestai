import "server-only";
import type { Repositories } from "../types";
import { FixtureExternalListingRepository } from "./external-listings";
import { FixtureLeadRepository } from "./leads";
import { FixtureProjectRepository } from "./projects";

export { FixtureProjectRepository, FixtureExternalListingRepository, FixtureLeadRepository };
export { SAMPLE_PROJECTS } from "./sample-projects";

export function createFixtureRepositories(): Repositories {
  return {
    backend: "fixture",
    projects: new FixtureProjectRepository(),
    externalListings: new FixtureExternalListingRepository(),
    leads: new FixtureLeadRepository(),
  };
}
