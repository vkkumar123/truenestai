"use client";

import { useActionState } from "react";
import { extractDocumentAction } from "@/server/actions/document-extraction";
import type { ExtractDocumentActionState } from "@/server/actions/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initial: ExtractDocumentActionState = { status: "idle" };

/** Staff "Extract details" action for one document version (server action, audited). */
export function ExtractDocumentForm({ documentId, label, retry }: { documentId: string; label: string; retry: boolean }) {
  const [state, formAction, pending] = useActionState(extractDocumentAction, initial);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="documentId" value={documentId} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending} aria-describedby={`extract-hint-${documentId}`}>
        {pending ? "Extracting… (up to 2 minutes)" : retry ? "Try extraction again" : "Extract details"}
        <span className="sr-only"> from {label}</span>
      </Button>
      <p id={`extract-hint-${documentId}`} className="text-xs text-muted-foreground">
        AI reads this PDF and lists the project details it finds, each with its page. Nothing is published or verified.
      </p>
      {state.status !== "idle" ? (
        <Alert tone={state.status === "success" ? "success" : "warning"} role={state.status === "success" ? "status" : "alert"}>
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}
