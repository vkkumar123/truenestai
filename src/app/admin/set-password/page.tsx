import type { Metadata } from "next";
import { MIN_STAFF_PASSWORD_LENGTH } from "@/server/auth";
import { SetPasswordForm } from "@/components/admin/set-password-form";

export const metadata: Metadata = { title: "Set your password", robots: { index: false, follow: false } };

// Landing page for Supabase invite and password-reset links (forwarded here by /admin/login).
export default function SetPasswordPage() {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Set your password</h1>
      <SetPasswordForm minLength={MIN_STAFF_PASSWORD_LENGTH} />
    </div>
  );
}
