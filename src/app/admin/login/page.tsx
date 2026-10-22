import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { dataBackend } from "@/server/env";
import { AdminLoginForm } from "@/components/admin/login-form";

export const metadata: Metadata = { title: "Staff sign-in", robots: { index: false, follow: false } };

export default function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  return (
    <div className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Staff sign-in</h1>
      <Suspense fallback={<div aria-busy="true" className="h-48 animate-pulse rounded-lg bg-muted" />}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LoginContent({ searchParams }: { searchParams: PageProps<"/admin/login">["searchParams"] }) {
  await connection(); // the backend mode is a runtime setting, not a build-time one
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  let mode: "fixture" | "supabase" = "fixture";
  try {
    mode = dataBackend();
  } catch {
    mode = "fixture";
  }
  return <AdminLoginForm mode={mode} next={next} />;
}
