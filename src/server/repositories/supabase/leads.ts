import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "@/domain/types";
import { canTransition, computeRetentionUntil, ERASED } from "@/leads/retention";
import {
  clampLimit,
  DEFAULT_LEAD_LIMIT,
  MAX_LEAD_LIMIT,
  type LeadFilter,
  type AssignLeadResult,
  type LeadRepository,
  type StaffMember,
  type StoredLead,
  type UpdateLeadStatusResult,
} from "../types";
import { leadToRow, mapLeadRow, type LeadRow } from "./mappers";

/**
 * Uses the SERVICE-ROLE client (server-only). Callers must already have enforced access:
 * services/leads.ts requires a staff session for list/getById/updateStatus. The database
 * additionally enforces consent, status-transition and audit rules.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SupabaseLeadRepository implements LeadRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  async create(lead: StoredLead): Promise<StoredLead> {
    // The DB writes the 'created' audit event via trigger.
    const { data, error } = await this.db().from("leads").insert(leadToRow(lead)).select("*").single();
    if (error) throw new Error(`create lead failed (${error.code ?? "unknown"})`); // no PII in message
    return mapLeadRow(data as LeadRow);
  }

  async list(filter: LeadFilter = {}): Promise<StoredLead[]> {
    const limit = clampLimit(filter.limit, DEFAULT_LEAD_LIMIT, MAX_LEAD_LIMIT);
    let q = this.db().from("leads").select("*").order("created_at", { ascending: false }).limit(limit);
    if (filter.status) q = q.eq("status", filter.status);
    if (filter.requestType) q = q.eq("request_type", filter.requestType);
    if (filter.assignedTo) q = q.eq("assigned_to", filter.assignedTo);
    const { data, error } = await q;
    if (error) throw new Error(`list leads failed (${error.code ?? "unknown"})`);
    return (data as LeadRow[]).map(mapLeadRow);
  }

  async getById(id: string): Promise<StoredLead | null> {
    const { data, error } = await this.db().from("leads").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`get lead failed (${error.code ?? "unknown"})`);
    return data ? mapLeadRow(data as LeadRow) : null;
  }

  async updateStatus(id: string, status: LeadStatus, actorId: string): Promise<UpdateLeadStatusResult> {
    const current = await this.getById(id);
    if (!current) return { ok: false, error: "not_found", message: "Lead not found." };
    if (!canTransition(current.status, status)) {
      return { ok: false, error: "invalid_transition", message: `Cannot move a lead from "${current.status}" to "${status}".` };
    }
    const patch: Partial<LeadRow> = { status, retention_until: computeRetentionUntil(current.createdAt, status) };
    if (status === "withdrawn") {
      Object.assign(patch, {
        name: ERASED,
        email: null,
        phone: null,
        message: null,
        budget_band: null,
        contact_consent: false,
        marketing_consent: false,
        attribution: {},
        qualification_score: null,
        qualification_tier: null,
        qualification_reasons: null,
      });
    }
    // Optimistic concurrency: only update if the status is still what we checked.
    const { data, error } = await this.db()
      .from("leads")
      .update(patch)
      .eq("id", id)
      .eq("status", current.status)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`update lead failed (${error.code ?? "unknown"})`);
    if (!data) return { ok: false, error: "invalid_transition", message: "Lead changed concurrently; reload and retry." };
    const events: Record<string, unknown>[] = [
      { lead_id: id, actor_id: actorId, event_type: "status_changed", from_status: current.status, to_status: status },
    ];
    if (status === "withdrawn") events.push({ lead_id: id, actor_id: actorId, event_type: "erased", from_status: status, to_status: status });
    const ev = await this.db().from("lead_events").insert(events);
    if (ev.error) throw new Error(`lead audit failed (${ev.error.code ?? "unknown"})`);
    return { ok: true, lead: mapLeadRow(data as LeadRow) };
  }

  async assign(id: string, assigneeId: string | null, actorId: string): Promise<AssignLeadResult> {
    if (!UUID.test(id) || (assigneeId !== null && !UUID.test(assigneeId)) || !UUID.test(actorId)) {
      return { ok: false, error: "validation", message: "Invalid lead or staff id." };
    }
    // lead_assign (0003_m2_live.sql): row lock + update + 'assigned' audit event in one transaction.
    const { data, error } = await this.db().rpc("lead_assign", { p_lead_id: id, p_assignee: assigneeId, p_actor_id: actorId });
    if (error) throw new Error(`assign lead failed (${error.code ?? "unknown"})`);
    const status = (data as { status: string }).status;
    if (status === "not_found") return { ok: false, error: "not_found", message: "Lead not found." };
    if (status === "withdrawn") return { ok: false, error: "validation", message: "A withdrawn lead cannot be assigned." };
    if (status === "unknown_assignee") return { ok: false, error: "validation", message: "Unknown staff member." };
    const lead = await this.getById(id);
    if (!lead) return { ok: false, error: "not_found", message: "Lead not found." };
    return { ok: true, lead, changed: status === "ok" };
  }

  async listStaff(): Promise<StaffMember[]> {
    const { data, error } = await this.db().from("staff_profiles").select("user_id, role, display_name").order("display_name").limit(500);
    if (error) throw new Error(`list staff failed (${error.code ?? "unknown"})`);
    return (data as { user_id: string; role: StaffMember["role"]; display_name: string | null }[]).map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.display_name,
    }));
  }
}
