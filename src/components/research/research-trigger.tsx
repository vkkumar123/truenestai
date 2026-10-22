"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { startWebResearchAction } from "@/server/actions/research-jobs";
import type { WebResearchActionState } from "@/server/actions/types";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResearchNotice } from "./research-notice";

const initial: WebResearchActionState = { status: "idle" };

/**
 * Starts on-demand research for a search miss with a POST (Server Action), never during the GET
 * render. With JavaScript it submits itself once on mount; without it the buyer presses the
 * button (the form still works: Server Action forms are progressively enhanced).
 */
export function ResearchTrigger({ queryText, localityId }: { queryText: string; localityId: string | null }) {
  const [state, formAction, pending] = useActionState(startWebResearchAction, initial);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fd = new FormData();
    fd.set("q", queryText);
    if (localityId) fd.set("locality", localityId);
    startTransition(() => formAction(fd));
  }, [formAction, queryText, localityId]);

  if (state.status === "researching" || state.status === "searched_none" || state.status === "unavailable") {
    return <ResearchNotice state={state} />;
  }
  if (state.status === "none") return null;
  return (
    <form action={formAction}>
      <input type="hidden" name="q" value={queryText} />
      {localityId ? <input type="hidden" name="locality" value={localityId} /> : null}
      <Alert role="status">
        <AlertTitle>{pending ? `Checking public sources for “${queryText}”…` : `Look up “${queryText}” on public web sources?`}</AlertTitle>
        <p className="mb-2">
          We can search public web pages for this. Anything we find is labelled unverified until TrueNest checks it.
        </p>
        <Button type="submit" size="sm" disabled={pending}>
          Research this search
        </Button>
      </Alert>
    </form>
  );
}
