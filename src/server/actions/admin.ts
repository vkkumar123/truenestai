"use server";
import "server-only";
import { redirect } from "next/navigation";
import { dataBackend } from "../env";
import { loginWithDevPassword, loginWithSupabasePassword, logoutStaff, MIN_STAFF_PASSWORD_LENGTH, setStaffPasswordFromLink } from "../auth";
import type { AdminLoginState, SetPasswordState } from "./types";
import { safeAdminPath } from "../redirects";
import { ensureRenderPhaseAfterAction } from "./mpa";
import { requestClientKey } from "../client-ip";
import { log } from "../log";
import { isLoginThrottled, LOGIN_THROTTLED_MESSAGE, recordLoginFailure } from "../services/login-throttle";

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
  // L2: refuse while this IP (or, in Supabase mode, this email) has too many recent FAILED attempts.
  const attempt = { ipKey: await requestClientKey(), email: supabaseMode ? (email as string) : null };
  if (isLoginThrottled(attempt)) {
    log.warn("auth.login_throttled");
    ensureRenderPhaseAfterAction("/admin/login");
    return { status: "error", message: LOGIN_THROTTLED_MESSAGE };
  }
  const result = supabaseMode
    ? await loginWithSupabasePassword((email as string).trim(), password)
    : await loginWithDevPassword(password);
  if (!result.ok) {
    // Count wrong credentials and non-staff accounts; not server misconfiguration.
    if (result.error === "invalid_credentials" || result.error === "not_staff") recordLoginFailure(attempt);
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

/**
 * Sets the password from an invite / reset link. Use with `useActionState(setPasswordAction, { status: "idle" })`.
 * Fields: `access_token`, `refresh_token` (from the link's URL fragment), `password`, `confirm`.
 * Redirects to /admin on success.
 */
export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const accessToken = formData.get("access_token");
  const refreshToken = formData.get("refresh_token");
  const password = formData.get("password");
  const confirm = formData.get("confirm");
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !accessToken || !refreshToken
    || accessToken.length > 8192 || refreshToken.length > 1024) {
    return { status: "error", linkInvalid: true, message: "This link is incomplete. Open the link from your email again." };
  }
  if (typeof password !== "string" || password.length < MIN_STAFF_PASSWORD_LENGTH || password.length > 512) {
    return { status: "error", message: `Use at least ${MIN_STAFF_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirm) return { status: "error", message: "The two passwords do not match." };
  const result = await setStaffPasswordFromLink(accessToken, refreshToken, password);
  ensureRenderPhaseAfterAction("/admin/set-password");
  if (!result.ok) return { status: "error", message: result.message, linkInvalid: result.error === "link_invalid" };
  redirect("/admin");
}
