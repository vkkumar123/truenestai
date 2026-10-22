"use server";
import "server-only";
import { redirect } from "next/navigation";
import { dataBackend } from "../env";
import { loginWithDevPassword, loginWithSupabasePassword, logoutStaff } from "../auth";
import type { AdminLoginState } from "./types";
import { safeAdminPath } from "../redirects";
import { ensureRenderPhaseAfterAction } from "./mpa";

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
  let result;
  if (dataBackend() === "supabase") {
    const email = formData.get("email");
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) {
      return { status: "error", message: "Enter a valid email address." };
    }
    result = await loginWithSupabasePassword(email.trim(), password);
  } else {
    result = await loginWithDevPassword(password);
  }
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
