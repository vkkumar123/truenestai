import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getStaffSession, type StaffSession } from "@/server/auth";

/**
 * Server-side staff check for admin pages (the proxy is only a fast path). Redirects to the
 * login page when there is no valid session. Call inside a <Suspense> boundary.
 */
export async function requireStaffPage(next: string): Promise<StaffSession> {
  await connection(); // session checks read cookies and the current time: request-time only
  const session = await getStaffSession();
  if (!session) redirect(`/admin/login?next=${encodeURIComponent(next)}`);
  return session;
}
