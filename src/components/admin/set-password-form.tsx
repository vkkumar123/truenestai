"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { setPasswordAction } from "@/server/actions/admin";
import type { SetPasswordState } from "@/server/actions/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initial: SetPasswordState = { status: "idle" };

type LinkTokens = { accessToken: string; refreshToken: string } | { error: string } | null;

/** Reads Supabase's implicit-flow fragment (#access_token=…&refresh_token=…&type=invite|recovery). */
function readLinkFragment(hash: string): LinkTokens {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (accessToken && refreshToken) return { accessToken, refreshToken };
  if (params.get("error") || params.get("error_code")) {
    return { error: "This link has expired or was already used. Ask an admin for a new one." };
  }
  return { error: "Open this page from the invite or password-reset link in your email." };
}

export function SetPasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction, pending] = useActionState(setPasswordAction, initial);
  const [link, setLink] = useState<LinkTokens>(null);
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return; // the fragment is cleared below; a second (Strict Mode) run must not re-read it
    read.current = true;
    // Fragment is browser-only; reading it after mount is the only way to see it.
    setLink(readLinkFragment(window.location.hash));
    // Keep tokens out of history and out of anything copied from the address bar.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  if (link === null) return <div aria-busy="true" className="h-48 animate-pulse rounded-lg bg-muted" />;
  if ("error" in link) {
    return (
      <Alert tone="danger" role="alert">
        {link.error}
      </Alert>
    );
  }
  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-border bg-surface p-4">
      {state.status === "error" ? (
        <Alert tone="danger" role="alert">
          {state.message}
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={minLength} maxLength={512} />
        <p className="text-xs text-muted-foreground">At least {minLength} characters.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Repeat password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={minLength} maxLength={512} />
      </div>
      <input type="hidden" name="access_token" value={link.accessToken} />
      <input type="hidden" name="refresh_token" value={link.refreshToken} />
      <Button type="submit" disabled={pending || (state.status === "error" && state.linkInvalid)} className="w-full">
        {pending ? "Saving…" : "Set password and sign in"}
      </Button>
    </form>
  );
}
