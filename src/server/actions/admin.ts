"use server";
import "server-only";
import { redirect } from "next/navigation";
import { dataBackend } from "../env";
import { loginWithDevPassword, loginWithSupabasePassword, logoutStaff } from "../auth";
import type { AdminLoginState } from "./types";
import { safeAdminPath } from "../redirects";
import { ensureRenderPhaseAfterAction } from "./mpa";
import { requestClientKey } from "../client-ip";
import { log } from "../log";
import { allowLoginAttempt, LOGIN_THROTTLED_MESSAGE } from "../services/login-throttle";

const LOGIN_PATH = "/admin/login";

/**
 * Staff sign-in. Use with `useActionState(adminLoginAction, { status: "idle" })`.
 * Fixture mode (dev only): field `password` (checked against ADMIN_DEV_PASSWORD).
 * Supabase mode: fields `email` and `password` (Supabase Auth + staff_profiles role).
 * Optional field `next`: an /admin path to go to after sign-in. Redirects on success.
 */
export async function adminLoginAction(_prev: AdminLoginState, formData: FormData): Promise<AdminLoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0 || password.length > 512) {
    return { status: "error", message: "Enter your password." };
  }
  const supabaseMode = dataBackend() === "supabase";
  const email = formData.get("email");
  if (supabaseMode && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254)) {
    return { status: "error", message: "Enter a valid email address." };
  }
  // L2: throttle per client IP (and per email in Supabase mode) before checking credentials.
  if (!allowLoginAttempt({ ipKey: await requestClientKey(), email: supabaseMode ? (email as string) : null })) {
    log.warn("auth.login_throttled");
    ensureRenderPhaseAfterAction("/admin/login");
    return { status: "error", message: LOGIN_THROTTLED_MESSAGE };
  }
  const result = supabaseMode
    ? await loginWithSupabasePassword((email as string).trim(), password)
    : await loginWithDevPassword(password);
  if (!result.ok) {
    ensureRenderPhaseAfterAction("/admin/login"); // failed login re-renders the page; see mpa.ts
    return { status: "error", message: result.message };
  }
  redirect(safeAdminPath(formData.get("next"))); // outside try/catch: redirect() throws by design
}

/** Signs out and redirects to the login page. Usable directly as `<form action={adminLogoutAction}>`. */
export async function adminLogoutAction(): Promise<void> {
  await logoutStaff();
  redirect(LOGIN_PATH);
}
