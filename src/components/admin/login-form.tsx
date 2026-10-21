"use client";

import { useActionState } from "react";
import { adminLoginAction } from "@/server/actions/admin";
import type { AdminLoginState } from "@/server/actions/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: AdminLoginState = { status: "idle" };

export function AdminLoginForm({ mode, next }: { mode: "fixture" | "supabase"; next: string }) {
  const [state, formAction, pending] = useActionState(adminLoginAction, initial);
  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-border bg-surface p-4">
      {state.status === "error" ? (
        <Alert tone="danger" role="alert">
          {state.message}
        </Alert>
      ) : null}
      {mode === "supabase" ? (
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Development sign-in (fixture mode). Disabled in production.</p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={512} />
      </div>
      <input type="hidden" name="next" value={next} />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
