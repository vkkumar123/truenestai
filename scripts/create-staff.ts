// Creates (invites) a staff user and sets their role. Uses the SERVICE ROLE key — run only on a
// trusted machine; the key is read from the environment and never printed.
//   npm run staff:create -- --email owner@example.com --role admin --name "Owner" [--dry-run]
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see docs/SUPABASE_SETUP.md).
import { createClient } from "@supabase/supabase-js";
import { CREATE_STAFF_USAGE, createStaff, parseCreateStaffArgs, type StaffAdminApi } from "../src/server/admin/staff-bootstrap";

function adminApi(url: string, serviceRoleKey: string): StaffAdminApi {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async findUserIdByEmail(email) {
      // No get-by-email in the admin API: page through users (staff counts are small).
      for (let page = 1; page <= 50; page++) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(`listUsers failed (${error.status ?? "unknown"})`);
        const hit = data.users.find((u) => u.email?.toLowerCase() === email);
        if (hit) return hit.id;
        if (data.users.length < 200) return null;
      }
      throw new Error("too many users to scan; look the user up in the dashboard");
    },
    async inviteUser(email, redirectTo) {
      const { data, error } = await db.auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined);
      if (error || !data.user) throw new Error(`invite failed (${error?.status ?? "unknown"}: ${error?.code ?? ""})`);
      return data.user.id;
    },
    async getStaffProfile(userId) {
      const { data, error } = await db.from("staff_profiles").select("role, display_name").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`staff_profiles read failed (${error.code ?? "unknown"})`);
      return data ? { role: data.role, displayName: data.display_name } : null;
    },
    async upsertStaffProfile(p) {
      const { error } = await db
        .from("staff_profiles")
        .upsert({ user_id: p.userId, role: p.role, display_name: p.displayName }, { onConflict: "user_id" });
      if (error) throw new Error(`staff_profiles upsert failed (${error.code ?? "unknown"})`);
    },
  };
}

async function main(): Promise<number> {
  const parsed = parseCreateStaffArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${CREATE_STAFF_USAGE}`);
    return 2;
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (docs/SUPABASE_SETUP.md).");
    return 2;
  }
  const { args } = parsed;
  try {
    const r = await createStaff(args, adminApi(url, key));
    console.log(
      `${args.dryRun ? "[dry run] " : ""}user: ${r.userAction}${r.userId ? ` (${r.userId})` : ""}; ` +
        `staff profile: ${r.profileAction} as ${args.role}${r.previousRole && r.previousRole !== args.role ? ` (was ${r.previousRole})` : ""}`,
    );
    if (r.userAction === "invited") console.log("An invite email was sent by Supabase Auth; the user sets their password from it.");
    return 0;
  } catch (e) {
    console.error(`create-staff failed: ${e instanceof Error ? e.message : "unknown error"}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
