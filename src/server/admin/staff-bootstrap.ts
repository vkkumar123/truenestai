import "server-only";
import { z } from "zod";

// Staff bootstrap (scripts/create-staff.ts): find-or-invite a Supabase Auth user by email, then
// upsert public.staff_profiles (role + display name) with the service role. Passwords are never
// accepted on the command line: new users get Supabase's invite email and set their own.
// The Supabase calls sit behind StaffAdminApi so the flow is unit-testable without a project.

export type StaffRoleArg = "admin" | "advisor";

export interface CreateStaffArgs {
  email: string;
  role: StaffRoleArg;
  displayName: string | null;
  dryRun: boolean;
  /** Where the invite link lands (your site's /admin/login). Optional. */
  redirectTo: string | null;
}

const argsSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("--email must be a valid email address")),
  role: z.enum(["admin", "advisor"], { message: "--role must be admin or advisor" }),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(80, "--name must be at most 80 characters")
    .regex(/^[^\p{Cc}]+$/u, "--name must not contain control characters")
    .nullable(),
  dryRun: z.boolean(),
  redirectTo: z.url({ protocol: /^https?$/, message: "--redirect-to must be an http(s) URL" }).nullable(),
});

export const CREATE_STAFF_USAGE =
  'Usage: create-staff --email <email> --role admin|advisor [--name "Display Name"] [--redirect-to <url>] [--dry-run]';

/** Parses `--flag value` / `--flag=value` arguments. Rejects unknown flags and password flags. */
export function parseCreateStaffArgs(argv: readonly string[]): { ok: true; args: CreateStaffArgs } | { ok: false; error: string } {
  const raw: Record<string, string | boolean> = {};
  const VALUE_FLAGS = new Set(["email", "role", "name", "redirect-to"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return { ok: false, error: `Unexpected argument: ${a.slice(0, 40)}` };
    const eq = a.indexOf("=");
    const key = a.slice(2, eq === -1 ? undefined : eq);
    if (key === "password" || key === "pass") {
      return { ok: false, error: "Passwords are never passed on the command line; the user sets one via the invite email." };
    }
    if (key === "dry-run") {
      raw.dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) return { ok: false, error: `Unknown flag: --${key.slice(0, 40)}` };
    const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `--${key} needs a value` };
    if (key in raw || (key === "redirect-to" && "redirectTo" in raw)) return { ok: false, error: `--${key} given twice` };
    raw[key === "redirect-to" ? "redirectTo" : key === "name" ? "displayName" : key] = value;
  }
  if (raw.email === undefined) return { ok: false, error: "--email is required" };
  if (raw.role === undefined) return { ok: false, error: "--role is required" };
  const parsed = argsSchema.safeParse({
    email: raw.email,
    role: raw.role,
    displayName: raw.displayName ?? null,
    dryRun: raw.dryRun === true,
    redirectTo: raw.redirectTo ?? null,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  return { ok: true, args: parsed.data };
}

/** The Supabase operations the bootstrap needs (service role). */
export interface StaffAdminApi {
  findUserIdByEmail(email: string): Promise<string | null>;
  inviteUser(email: string, redirectTo: string | null): Promise<string>;
  getStaffProfile(userId: string): Promise<{ role: StaffRoleArg; displayName: string | null } | null>;
  upsertStaffProfile(profile: { userId: string; role: StaffRoleArg; displayName: string | null }): Promise<void>;
}

export interface CreateStaffOutcome {
  userId: string | null;
  userAction: "existing" | "invited" | "would_invite";
  profileAction: "created" | "updated" | "unchanged" | "would_create" | "would_update";
  previousRole: StaffRoleArg | null;
}

/** Idempotent: re-running with the same args changes nothing. Dry run performs reads only. */
export async function createStaff(args: CreateStaffArgs, api: StaffAdminApi): Promise<CreateStaffOutcome> {
  let userId = await api.findUserIdByEmail(args.email);
  let userAction: CreateStaffOutcome["userAction"] = "existing";
  if (!userId) {
    if (args.dryRun) return { userId: null, userAction: "would_invite", profileAction: "would_create", previousRole: null };
    userId = await api.inviteUser(args.email, args.redirectTo);
    userAction = "invited";
  }
  const current = await api.getStaffProfile(userId);
  const displayName = args.displayName ?? current?.displayName ?? null;
  const same = current && current.role === args.role && current.displayName === displayName;
  if (same) return { userId, userAction, profileAction: "unchanged", previousRole: current.role };
  if (args.dryRun) {
    return { userId, userAction, profileAction: current ? "would_update" : "would_create", previousRole: current?.role ?? null };
  }
  await api.upsertStaffProfile({ userId, role: args.role, displayName });
  return { userId, userAction, profileAction: current ? "updated" : "created", previousRole: current?.role ?? null };
}
