import "server-only";
import type { Project } from "@/domain/types";
import type { Repositories } from "../types";
import { FixtureDevelopmentRepository } from "./developments";
import { FixtureExternalListingRepository } from "./external-listings";
import { FixtureFactStoreRepository } from "./fact-store";
import { FixtureLeadRepository } from "./leads";
import { FixtureProjectRepository } from "./projects";
import { FixtureResearchRepository } from "./research";
import { FixtureResearchJobRepository } from "./research-jobs";
import { SAMPLE_PROJECTS } from "./sample-projects";
import { FixtureDocumentStorage } from "../../storage/documents";

export { FixtureProjectRepository, FixtureExternalListingRepository, FixtureLeadRepository, FixtureResearchRepository, FixtureResearchJobRepository, FixtureFactStoreRepository, FixtureDevelopmentRepository };
export { SAMPLE_PROJECTS };

/** Public reads and staff writes share one mutable copy of the sample projects. */
export function createFixtureRepositories(): Repositories {
  const store: Project[] = structuredClone([...SAMPLE_PROJECTS]);
  const externalListings = new FixtureExternalListingRepository();
  return {
    backend: "fixture",
    projects: new FixtureProjectRepository(store),
    research: new FixtureResearchRepository(store),
    externalListings,
    researchJobs: new FixtureResearchJobRepository(externalListings),
    leads: new FixtureLeadRepository(),
    factStore: new FixtureFactStoreRepository(store),
    developments: new FixtureDevelopmentRepository(),
    documentStorage: new FixtureDocumentStorage(),
  };
}
