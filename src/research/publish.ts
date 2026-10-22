// Publish readiness for researched projects (M3, D12). Pure.
// ASSUMPTION PENDING OWNER APPROVAL: the blocker rules and PUBLISH_MIN_COMPLETENESS below
// are a proposed default (D12), not an owner-approved policy.
import type { FactValue, Project, PublishReadiness, ResearchFactField, StaffRole } from "@/domain/types";
import { RESEARCH_FACT_FIELDS } from "./fact-edit";

export const PUBLISH_ROLE: StaffRole = "admin"; // enforced by the service layer, not here
export const PUBLISH_MIN_COMPLETENESS = 0.6; // assumption pending owner approval

const COMPLETENESS_ITEMS = RESEARCH_FACT_FIELDS.length + 1; // + "≥1 unit with known price and area"

function researchFact(project: Project, field: ResearchFactField): FactValue<unknown> {
  return project[field] as FactValue<unknown>;
}

function hasKnownUnit(project: Project): boolean {
  return (project.units ?? []).some((u) => u.priceInr?.status === "known" && u.carpetAreaSqft?.status === "known");
}

/** Share (0..1) of the 4 research fact fields known, plus one item for a unit with known price and area. */
export function computeCompleteness(project: Project): number {
  let known = RESEARCH_FACT_FIELDS.filter((f) => researchFact(project, f)?.status === "known").length;
  if (hasKnownUnit(project)) known += 1;
  return Math.round((known / COMPLETENESS_ITEMS) * 1000) / 1000;
}

export function evaluatePublishReadiness(project: Project): PublishReadiness {
  const blockers: string[] = [];
  const completeness = computeCompleteness(project);

  for (const f of RESEARCH_FACT_FIELDS) {
    const fact = researchFact(project, f);
    if (!fact) continue;
    // Assumption: every known fact needs provenance.
    if (fact.status === "known" && (fact.sources ?? []).length === 0) blockers.push(`${f}: known value has no source`);
    // Assumption: any disputed fact blocks publishing.
    if (fact.verification === "disputed") blockers.push(`${f}: disputed`);
  }

  // Assumption: a RERA reference must be known and confirmed against the source or reviewed.
  const rera = project.reraNumbers;
  if (!rera || rera.status !== "known" || !Array.isArray(rera.value) || rera.value.length === 0) {
    blockers.push("reraNumbers: not known");
  } else if (rera.verification !== "source_confirmed" && rera.verification !== "reviewed") {
    blockers.push("reraNumbers: must be source_confirmed or reviewed");
  }

  // Assumption: construction status must be known.
  if (!project.constructionStatus || project.constructionStatus.status !== "known") {
    blockers.push("constructionStatus: not known");
  }

  if (completeness < PUBLISH_MIN_COMPLETENESS) {
    blockers.push(`completeness ${Math.round(completeness * 100)}% is below ${Math.round(PUBLISH_MIN_COMPLETENESS * 100)}%`);
  }

  return { ready: blockers.length === 0, completeness, blockers };
}
