import "server-only";
import type { Project } from "@/domain/types";
import type { Repositories } from "../types";
import { FixtureExternalListingRepository } from "./external-listings";
import { FixtureDocumentExtractionRepository } from "./document-extractions";
import { FixtureFactStoreRepository, SAMPLE_FACT_OBSERVATIONS } from "./fact-store";
import { FixtureLeadRepository } from "./leads";
import { FixtureProjectRepository } from "./projects";
import { FixtureResearchRepository } from "./research";
import { FixtureResearchJobRepository } from "./research-jobs";
import { SAMPLE_PROJECTS } from "./sample-projects";
import { FixtureDocumentStorage } from "../../storage/documents";

export { FixtureProjectRepository, FixtureExternalListingRepository, FixtureLeadRepository, FixtureResearchRepository, FixtureResearchJobRepository, FixtureFactStoreRepository, FixtureDocumentExtractionRepository };
export { SAMPLE_PROJECTS };

/** Public reads and staff writes share one mutable copy of the sample projects. */
export function createFixtureRepositories(): Repositories {
  const store: Project[] = structuredClone([...SAMPLE_PROJECTS]);
  const externalListings = new FixtureExternalListingRepository();
  const research = new FixtureResearchRepository(store);
  // shared: document extraction appends observations that facts_current then sees
  const observations = [...SAMPLE_FACT_OBSERVATIONS];
  return {
    backend: "fixture",
    projects: new FixtureProjectRepository(store),
    research,
    externalListings,
    researchJobs: new FixtureResearchJobRepository(externalListings),
    leads: new FixtureLeadRepository(),
    factStore: new FixtureFactStoreRepository(store, observations),
    documentExtractions: new FixtureDocumentExtractionRepository(research, store, observations),
    documentStorage: new FixtureDocumentStorage(),
  };
}
