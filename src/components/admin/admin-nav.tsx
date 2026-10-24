import Link from "next/link";
import { connection } from "next/server";
import { adminLogoutAction } from "@/server/actions/admin";
import { getStaffSession } from "@/server/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Staff navigation. Renders only a label when nobody is signed in (e.g. on the login page). */
export async function AdminNav() {
  await connection();
  const session = await getStaffSession();
  if (!session) {
    return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">TrueNest staff area</p>;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <nav aria-label="Staff">
        <ul className="flex items-center gap-1 text-sm">
          <li>
            <Link href="/admin/leads" className="rounded-md px-3 py-1.5 font-medium hover:bg-muted">
              Leads
            </Link>
          </li>
          <li>
            <Link href="/admin/projects" className="rounded-md px-3 py-1.5 font-medium hover:bg-muted">
              Projects
            </Link>
          </li>
          <li>
            <Link href="/admin/research-jobs" className="rounded-md px-3 py-1.5 font-medium hover:bg-muted">
              Research jobs
            </Link>
          </li>
          <li>
            <Link href="/admin/developments" className="rounded-md px-3 py-1.5 font-medium hover:bg-muted">
              Developments
            </Link>
          </li>
        </ul>
      </nav>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Signed in as <Badge tone={session.role === "admin" ? "info" : "neutral"}>{session.role}</Badge>
        </span>
        <form action={adminLogoutAction}>
          <Button type="submit" variant="secondary" size="sm">
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
