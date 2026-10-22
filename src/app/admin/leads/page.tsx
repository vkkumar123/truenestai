import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { LeadRequestType, LeadStatus } from "@/domain/types";
import { LEAD_STATUS_LABELS, REQUEST_TYPE_LABELS } from "@/leads/labels";
import { LEAD_STATUS_TRANSITIONS } from "@/leads/retention";
import { isStaffAuthError } from "@/server/auth";
import { requireStaffPage } from "../_lib/session";
import { listAssignableStaff, listLeads, type StaffLeadView } from "@/server/services/leads";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import { AssignLeadForm } from "@/components/admin/assign-lead-form";
import { LeadStatusForm } from "@/components/admin/lead-status-form";
import { EXTERNAL_LABEL } from "@/components/property/external-card";
import { formatDate } from "@/components/property/format";
import { SafeExternalLink } from "@/components/property/safe-link";

export const metadata: Metadata = { title: "Leads", robots: { index: false, follow: false } };

const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "closed", "withdrawn"];
const REQUEST_TYPES: LeadRequestType[] = ["verification", "buyer_assistance"];

export default function AdminLeadsPage({ searchParams }: PageProps<"/admin/leads">) {
  return (
    <Suspense
      fallback={
        <div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted">
          <span className="sr-only">Loading…</span>
        </div>
      }
    >
      <LeadsContent searchParams={searchParams} />
    </Suspense>
  );
}

function filterHref(f: { status?: LeadStatus; requestType?: LeadRequestType }): string {
  const sp = new URLSearchParams();
  if (f.status) sp.set("status", f.status);
  if (f.requestType) sp.set("requestType", f.requestType);
  const s = sp.toString();
  return s ? `/admin/leads?${s}` : "/admin/leads";
}

function FilterPills<T extends string>({
  label,
  options,
  current,
  href,
  text,
}: {
  label: string;
  options: T[];
  current: T | undefined;
  href: (v: T | undefined) => string;
  text: (v: T) => string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap items-center gap-1.5 text-sm">
        <li className="mr-1 text-xs font-medium text-muted-foreground">{label}:</li>
        {[undefined, ...options].map((v) => (
          <li key={v ?? "all"}>
            <Link
              href={href(v)}
              aria-current={current === v ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1",
                current === v ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-muted",
              )}
            >
              {v ? text(v) : "All"}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Subject({ subject }: { subject: StaffLeadView["subject"] }) {
  if (!subject) return <span className="text-muted-foreground">General request</span>;
  if (subject.kind === "project") {
    return (
      <div className="space-y-0.5">
        <Badge tone="info">Researched project</Badge>
        <p>
          {subject.slug && subject.available ? (
            <Link href={`/projects/${subject.slug}`} className="text-primary underline">
              {subject.name ?? subject.id}
            </Link>
          ) : (
            <span>{subject.name ?? <code className="font-mono">{subject.id}</code>}</span>
          )}
        </p>
        {!subject.available ? <p className="text-muted-foreground">No longer published</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <Badge className="border-external/40 bg-external/10 text-external">{EXTERNAL_LABEL}</Badge>
      <p className="font-medium">{subject.title ?? <code className="font-mono">{subject.id}</code>}</p>
      {subject.available ? (
        <>
          <p className="text-muted-foreground">Source: {subject.sourceName ?? subject.sourceId ?? "Not recorded"}</p>
          {subject.canonicalUrl ? <SafeExternalLink url={subject.canonicalUrl} srLabel="(opens the source site in a new tab)" /> : null}
          <p className="text-muted-foreground">
            Discovered {formatDate(subject.discoveredAt)} · Last seen {subject.lastSeenAt ? formatDate(subject.lastSeenAt) : "not recorded"}
          </p>
        </>
      ) : (
        <p className="text-muted-foreground">Listing record no longer available</p>
      )}
    </div>
  );
}

async function LeadsContent({ searchParams }: { searchParams: PageProps<"/admin/leads">["searchParams"] }) {
  const session = await requireStaffPage("/admin/leads");

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = (STATUSES as string[]).includes(rawStatus) ? (rawStatus as LeadStatus) : undefined;
  const rawType = typeof sp.requestType === "string" ? sp.requestType : "";
  const requestType = (REQUEST_TYPES as string[]).includes(rawType) ? (rawType as LeadRequestType) : undefined;
  const isAdmin = session.role === "admin";

  let leads: StaffLeadView[];
  let staff: { userId: string; label: string }[] = [];
  try {
    // Advisors receive only leads assigned to them (enforced by the service).
    leads = await listLeads({ status, requestType, limit: 200 });
    if (isAdmin) {
      staff = (await listAssignableStaff()).map((m) => ({ userId: m.userId, label: `${m.displayName ?? m.userId} (${m.role})` }));
    }
  } catch (e) {
    if (isStaffAuthError(e)) redirect("/admin/login?next=%2Fadmin%2Fleads");
    throw e;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Buyer requests</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as <code className="font-mono">{session.userId}</code> ({session.role}, {session.mode} mode)
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <FilterPills
          label="Status"
          options={STATUSES}
          current={status}
          href={(v) => filterHref({ status: v, requestType })}
          text={(v) => LEAD_STATUS_LABELS[v]}
        />
        <FilterPills
          label="Request type"
          options={REQUEST_TYPES}
          current={requestType}
          href={(v) => filterHref({ status, requestType: v })}
          text={(v) => REQUEST_TYPE_LABELS[v]}
        />
      </div>

      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Only an admin can withdraw and erase a lead. You see the leads assigned to you.</p>
      ) : null}

      {leads.length === 0 ? (
        <Alert>
          {isAdmin ? (
            <>
              <AlertTitle>No requests match these filters</AlertTitle>
              <p>New buyer requests appear here once submitted with contact consent.</p>
            </>
          ) : (
            <>
              <AlertTitle>No leads assigned to you yet</AlertTitle>
              <p>An admin assigns buyer requests to advisors. Assigned leads appear here.</p>
            </>
          )}
        </Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-label="Buyer requests" tabIndex={0}>
          <table className="w-full min-w-[72rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Created", "Type", "Contact", "About", "Status", "Tier", "Assigned to", "Retain until", "Change status"].map((h) => (
                  <th key={h} scope="col" className="p-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b border-border align-top last:border-b-0">
                  <td className="whitespace-nowrap p-3">{formatDate(l.createdAt)}</td>
                  <td className="p-3">{REQUEST_TYPE_LABELS[l.requestType]}</td>
                  <td className="p-3">
                    <p className="font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Prefers {l.preferredChannel}
                      {l.email ? ` · ${l.email}` : ""}
                      {l.phone ? ` · ${l.phone}` : ""}
                    </p>
                    {l.consent.marketingConsent ? (
                      <Badge tone="info" className="mt-1">
                        Marketing opt-in
                      </Badge>
                    ) : null}
                  </td>
                  <td className="max-w-72 p-3 text-xs">
                    <Subject subject={l.subject} />
                  </td>
                  <td className="p-3">
                    <Badge tone={l.status === "new" ? "info" : l.status === "withdrawn" ? "neutral" : "outline"}>{LEAD_STATUS_LABELS[l.status]}</Badge>
                  </td>
                  <td className="p-3 capitalize">
                    {l.qualification ? (
                      <span title={l.qualification.reasons.join("; ")}>
                        {l.qualification.tier} <span className="text-xs text-muted-foreground">({l.qualification.score})</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Not scored</span>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    {isAdmin ? (
                      <AssignLeadForm leadId={l.id} assignedTo={l.assignedTo ?? null} staff={staff} />
                    ) : l.assignedTo ? (
                      l.assignedTo === session.userId ? "You" : l.assignedTo
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap p-3">{formatDate(l.retentionUntil)}</td>
                  <td className="p-3">
                    <LeadStatusForm
                      leadId={l.id}
                      options={LEAD_STATUS_TRANSITIONS[l.status]
                        .filter((s) => isAdmin || s !== "withdrawn")
                        .map((s) => ({ value: s, label: LEAD_STATUS_LABELS[s] }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
