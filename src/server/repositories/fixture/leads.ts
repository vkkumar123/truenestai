import "server-only";
import type { LeadStatus } from "@/domain/types";
import { canTransition, eraseLeadPii, transitionLead } from "@/leads/retention";
import { FIXTURE_ADMIN_USER_ID, FIXTURE_ADVISOR_USER_ID } from "../../auth";
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

export interface FixtureLeadEvent {
  leadId: string;
  actorId: string | null;
  type: "created" | "status_changed" | "erased" | "assigned";
  fromStatus: LeadStatus | null;
  toStatus: LeadStatus;
  assignedTo?: string | null;
  at: string;
}

/** The two dev-login identities (see auth.ts); fixture mode has no staff_profiles table. */
export const FIXTURE_STAFF: readonly StaffMember[] = [
  { userId: FIXTURE_ADMIN_USER_ID, role: "admin", displayName: "Dev admin (fixture)" },
  { userId: FIXTURE_ADVISOR_USER_ID, role: "advisor", displayName: "Dev advisor (fixture)" },
];

/**
 * DEV ONLY. Leads live in memory in the current server process: they are lost on restart,
 * not shared between instances/workers, and never persisted. Use DATA_BACKEND=supabase for
 * anything real. No PII is ever logged from here.
 */
export class FixtureLeadRepository implements LeadRepository {
  private readonly rows = new Map<string, StoredLead>();
  readonly events: FixtureLeadEvent[] = [];

  async create(lead: StoredLead): Promise<StoredLead> {
    if (!lead.consent.contactConsent) throw new Error("Refusing to store a lead without contact consent.");
    if (this.rows.has(lead.id)) throw new Error("Duplicate lead id.");
    this.rows.set(lead.id, structuredClone(lead));
    this.events.push({ leadId: lead.id, actorId: null, type: "created", fromStatus: null, toStatus: lead.status, at: lead.createdAt });
    return structuredClone(lead);
  }

  async list(filter: LeadFilter = {}): Promise<StoredLead[]> {
    const limit = clampLimit(filter.limit, DEFAULT_LEAD_LIMIT, MAX_LEAD_LIMIT);
    return [...this.rows.values()]
      .filter((l) => !filter.status || l.status === filter.status)
      .filter((l) => !filter.requestType || l.requestType === filter.requestType)
      .filter((l) => !filter.assignedTo || l.assignedTo === filter.assignedTo)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((l) => structuredClone(l));
  }

  async getById(id: string): Promise<StoredLead | null> {
    const l = this.rows.get(id);
    return l ? structuredClone(l) : null;
  }

  async updateStatus(id: string, status: LeadStatus, actorId: string): Promise<UpdateLeadStatusResult> {
    const current = this.rows.get(id);
    if (!current) return { ok: false, error: "not_found", message: "Lead not found." };
    if (!canTransition(current.status, status)) {
      return { ok: false, error: "invalid_transition", message: `Cannot move a lead from "${current.status}" to "${status}".` };
    }
    const t = transitionLead(current, status);
    if (!t.ok) return { ok: false, error: "invalid_transition", message: t.error };
    let next: StoredLead = { ...current, ...t.lead };
    const at = new Date().toISOString();
    this.events.push({ leadId: id, actorId, type: "status_changed", fromStatus: current.status, toStatus: status, at });
    if (status === "withdrawn") {
      next = { ...next, ...eraseLeadPii(next), qualification: null };
      this.events.push({ leadId: id, actorId, type: "erased", fromStatus: status, toStatus: status, at });
    }
    this.rows.set(id, next);
    return { ok: true, lead: structuredClone(next) };
  }

  async assign(id: string, assigneeId: string | null, actorId: string): Promise<AssignLeadResult> {
    const current = this.rows.get(id);
    if (!current) return { ok: false, error: "not_found", message: "Lead not found." };
    if (current.status === "withdrawn") return { ok: false, error: "validation", message: "A withdrawn lead cannot be assigned." };
    if (assigneeId !== null && !FIXTURE_STAFF.some((s) => s.userId === assigneeId)) {
      return { ok: false, error: "validation", message: "Unknown staff member." };
    }
    if ((current.assignedTo ?? null) === assigneeId) return { ok: true, lead: structuredClone(current), changed: false };
    const next: StoredLead = { ...current, assignedTo: assigneeId };
    this.rows.set(id, next);
    this.events.push({
      leadId: id, actorId, type: "assigned", fromStatus: current.status, toStatus: current.status, assignedTo: assigneeId,
      at: new Date().toISOString(),
    });
    return { ok: true, lead: structuredClone(next), changed: true };
  }

  async listStaff(): Promise<StaffMember[]> {
    return FIXTURE_STAFF.map((s) => ({ ...s }));
  }
}
