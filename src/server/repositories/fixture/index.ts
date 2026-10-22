import "server-only";
import type { Project } from "@/domain/types";
import type { Repositories } from "../types";
import { FixtureExternalListingRepository } from "./external-listings";
import { FixtureLeadRepository } from "./leads";
import { FixtureProjectRepository } from "./projects";
import { FixtureResearchRepository } from "./research";
import { SAMPLE_PROJECTS } from "./sample-projects";

export { FixtureProjectRepository, FixtureExternalListingRepository, FixtureLeadRepository, FixtureResearchRepository };
export { SAMPLE_PROJECTS };

/** Public reads and staff writes share one mutable copy of the sample projects. */
export function createFixtureRepositories(): Repositories {
  const store: Project[] = structuredClone([...SAMPLE_PROJECTS]);
  return {
    backend: "fixture",
    projects: new FixtureProjectRepository(store),
    research: new FixtureResearchRepository(store),
    externalListings: new FixtureExternalListingRepository(),
    leads: new FixtureLeadRepository(),
  };
}
