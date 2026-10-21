import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { LeadStatus } from "@/domain/types";
import { LEAD_STATUS_TRANSITIONS } from "@/leads/retention";
import { adminLogoutAction } from "@/server/actions/admin";
import { getStaffSession, isStaffAuthError } from "@/server/auth";
import { listLeads } from "@/server/services/leads";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { LeadStatusForm } from "@/components/admin/lead-status-form";
import { formatDate } from "@/components/property/format";

export const metadata: Metadata = { title: "Leads", robots: { index: false, follow: false } };

const STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "closed", "withdrawn"];

export default function AdminLeadsPage({ searchParams }: PageProps<"/admin/leads">) {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted"><span className="sr-only">Loading…</span></div>}>
      <LeadsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LeadsContent({ searchParams }: { searchParams: PageProps<"/admin/leads">["searchParams"] }) {
  await connection(); // session checks read cookies and the current time: request-time only
  const session = await getStaffSession();
  if (!session) redirect("/admin/login?next=%2Fadmin%2Fleads");

  const sp = await searchParams;
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const status = (STATUSES as string[]).includes(rawStatus) ? (rawStatus as LeadStatus) : undefined;

  let leads;
  try {
    leads = await listLeads({ status, limit: 200 });
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
        <form action={adminLogoutAction}>
          <Button type="submit" variant="secondary" size="sm">
            Sign out
          </Button>
        </form>
      </div>

      <nav aria-label="Filter by status">
        <ul className="flex flex-wrap gap-1.5 text-sm">
          {[{ v: undefined, label: "All" }, ...STATUSES.map((s) => ({ v: s, label: s }))].map((o) => (
            <li key={o.label}>
              <Link
                href={o.v ? `/admin/leads?status=${o.v}` : "/admin/leads"}
                aria-current={status === o.v ? "page" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 capitalize",
                  status === o.v ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface hover:bg-muted",
                )}
              >
                {o.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {leads.length === 0 ? (
        <Alert>
          <AlertTitle>No requests{status ? ` with status “${status}”` : ""}</AlertTitle>
          <p>New buyer requests appear here once submitted with contact consent.</p>
        </Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-label="Buyer requests" tabIndex={0}>
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Created", "Type", "Contact", "Property", "Status", "Tier", "Retain until", "Change status"].map((h) => (
                  <th key={h} scope="col" className="p-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-b border-border align-top last:border-b-0">
                  <td className="p-3 whitespace-nowrap">{formatDate(l.createdAt)}</td>
                  <td className="p-3">{l.requestType === "verification" ? "Verification" : "Buyer assistance"}</td>
                  <td className="p-3">
                    <p className="font-medium">{l.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Prefers {l.preferredChannel}
                      {l.email ? ` · ${l.email}` : ""}
                      {l.phone ? ` · ${l.phone}` : ""}
                    </p>
                    {l.consent.marketingConsent ? <Badge tone="info" className="mt-1">Marketing opt-in</Badge> : null}
                  </td>
                  <td className="p-3 text-xs">
                    {l.projectId ? <>Project <code className="font-mono">{l.projectId}</code></> : l.externalListingId ? <>External listing <code className="font-mono">{l.externalListingId}</code></> : "General"}
                  </td>
                  <td className="p-3 capitalize">
                    <Badge tone={l.status === "new" ? "info" : l.status === "withdrawn" ? "neutral" : "outline"}>{l.status}</Badge>
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
                  <td className="p-3 whitespace-nowrap">{formatDate(l.retentionUntil)}</td>
                  <td className="p-3">
                    <LeadStatusForm leadId={l.id} options={[...LEAD_STATUS_TRANSITIONS[l.status]]} />
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
