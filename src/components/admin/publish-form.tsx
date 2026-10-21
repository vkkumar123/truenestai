"use client";

import { useActionState } from "react";
import { setPublishedAction } from "@/server/actions/research";
import type { ResearchActionState } from "@/server/actions/types";
import { Button } from "@/components/ui/button";
import { ActionFeedback } from "./action-feedback";

const initial: ResearchActionState = { status: "idle" };

export function PublishForm({ projectId, published, ready }: { projectId: string; published: boolean; ready: boolean }) {
  const [state, formAction, pending] = useActionState(setPublishedAction, initial);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="published" value={published ? "false" : "true"} />
      <ActionFeedback state={state} />
      <Button type="submit" variant={published ? "secondary" : "primary"} disabled={pending}>
        {pending ? "Saving…" : published ? "Unpublish" : "Publish"}
      </Button>
      {!published && !ready ? (
        <p className="text-xs text-muted-foreground">Publishing will be refused until the blockers above are resolved.</p>
      ) : null}
    </form>
  );
}
