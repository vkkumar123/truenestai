import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FactAuditEvent, FactValue, Project, ResearchFactField, VerificationState } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { computeCompleteness } from "@/research/publish";
import type { NewProjectInput, ResearchRepository } from "../types";
import { slugify, uniqueSlug } from "../slug";
import { mapProjectRow, PROJECT_SELECT, type ProjectRow } from "./mappers";

export const DB_FACT_FIELD: Record<ResearchFactField, string> = {
  address: "address",
  reraNumbers: "rera_numbers",
  constructionStatus: "construction_status",
  declaredPossession: "declared_possession",
};

interface AuditRow {
  id: string;
  project_id: string;
  field: FactAuditEvent["field"];
  action: FactAuditEvent["action"];
  from_verification: VerificationState | null;
  to_verification: VerificationState | null;
  actor_id: string;
  actor_role: FactAuditEvent["actorRole"];
  at: string;
  note: string | null;
}

/**
 * SERVICE-ROLE staff write model (bypasses RLS: sees unpublished projects). Server-only; callers
 * enforce staff roles. Fact replacement is atomic via the `research_set_fact` SQL function.
 * Not exercised against a live Supabase yet (no credentials); SQL is covered by `npm run test:db`.
 */
export class SupabaseResearchRepository implements ResearchRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  async listAllProjects(): Promise<Project[]> {
    const { data, error } = await this.db().from("projects").select(PROJECT_SELECT).order("name").limit(500);
    if (error) throw new Error(`listAllProjects failed: ${error.message}`);
    return (data as unknown as ProjectRow[]).map(mapProjectRow);
  }

  async getProjectByIdForStaff(id: string): Promise<Project | null> {
    const { data, error } = await this.db().from("projects").select(PROJECT_SELECT).eq("id", id).maybeSingle();
    if (error) throw new Error(`getProjectByIdForStaff failed: ${error.message}`);
    return data ? mapProjectRow(data as unknown as ProjectRow) : null;
  }

  private async developerId(name: string): Promise<string> {
    const db = this.db();
    const found = await db.from("developers").select("id").eq("name", name).eq("is_sample", false).limit(1);
    if (found.error) throw new Error(`developer lookup failed: ${found.error.message}`);
    if (found.data?.length) return (found.data[0] as { id: string }).id;
    const ins = await db.from("developers").insert({ name, is_sample: false }).select("id").single();
    if (ins.error) throw new Error(`developer insert failed: ${ins.error.message}`);
    return (ins.data as { id: string }).id;
  }

  async createProject(input: NewProjectInput): Promise<Project> {
    if (!isActiveLocality(input.localityId)) throw new Error("Locality is not active.");
    const loc = getLocality(input.localityId)!;
    const base = slugify(`${input.name} ${loc.name}`);
    const db = this.db();
    const taken = await db.from("projects").select("slug").like("slug", `${base}%`);
    if (taken.error) throw new Error(`slug lookup failed: ${taken.error.message}`);
    const slug = uniqueSlug(base, new Set((taken.data as { slug: string }[]).map((r) => r.slug)));
    const hasPoint = input.lat !== undefined && input.lng !== undefined;
    const ins = await db
      .from("projects")
      .insert({
        slug,
        name: input.name.trim(),
        developer_id: await this.developerId(input.developerName.trim()),
        locality_id: input.localityId,
        lat: hasPoint ? input.lat : loc.centroid.lat,
        lng: hasPoint ? input.lng : loc.centroid.lng,
        location_precision: hasPoint ? "approximate" : "locality_centroid",
        completeness: 0,
        is_sample: false,
        published: false,
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`createProject failed (${ins.error.code ?? "unknown"})`);
    const project = await this.getProjectByIdForStaff((ins.data as { id: string }).id);
    if (!project) throw new Error("createProject: inserted row not readable");
    return project;
  }

  async setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>): Promise<Project | null> {
    const current = await this.getProjectByIdForStaff(projectId);
    if (!current) return null;
    const completeness = computeCompleteness({ ...current, [field]: fact } as Project);
    const { error } = await this.db().rpc("research_set_fact", {
      p_project_id: projectId,
      p_field: DB_FACT_FIELD[field],
      p_status: fact.status,
      p_value: fact.status === "known" ? fact.value : null,
      p_verification: fact.verification,
      p_sources: fact.sources,
      p_completeness: completeness,
    });
    if (error) throw new Error(`setFact failed (${error.code ?? "unknown"})`);
    return this.getProjectByIdForStaff(projectId);
  }

  async setFactVerification(projectId: string, field: ResearchFactField, to: VerificationState): Promise<Project | null> {
    const { error } = await this.db()
      .from("facts")
      .update({ verification: to })
      .eq("project_id", projectId)
      .eq("field", DB_FACT_FIELD[field])
      .is("unit_id", null)
      .eq("is_current", true);
    if (error) throw new Error(`setFactVerification failed (${error.code ?? "unknown"})`);
    return this.getProjectByIdForStaff(projectId);
  }

  async setPublished(projectId: string, published: boolean): Promise<Project | null> {
    const { data, error } = await this.db().from("projects").update({ published }).eq("id", projectId).select("id");
    if (error) throw new Error(`setPublished failed (${error.code ?? "unknown"})`);
    if (!data?.length) return null;
    return this.getProjectByIdForStaff(projectId);
  }

  async appendAudit(e: FactAuditEvent): Promise<void> {
    const row: AuditRow = {
      id: e.id,
      project_id: e.projectId,
      field: e.field,
      action: e.action,
      from_verification: e.fromVerification,
      to_verification: e.toVerification,
      actor_id: e.actorId,
      actor_role: e.actorRole,
      at: e.at,
      note: e.note,
    };
    const { error } = await this.db().from("fact_review_events").insert(row);
    if (error) throw new Error(`appendAudit failed (${error.code ?? "unknown"})`);
  }

  async listAudit(projectId: string): Promise<FactAuditEvent[]> {
    const { data, error } = await this.db()
      .from("fact_review_events")
      .select("*")
      .eq("project_id", projectId)
      .order("at", { ascending: true });
    if (error) throw new Error(`listAudit failed (${error.code ?? "unknown"})`);
    return (data as AuditRow[]).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      field: r.field,
      action: r.action,
      fromVerification: r.from_verification,
      toVerification: r.to_verification,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      at: r.at,
      note: r.note,
    }));
  }
}
