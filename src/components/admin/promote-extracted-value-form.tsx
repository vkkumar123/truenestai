"use client";

import { useActionState } from "react";
import { updateFactAction } from "@/server/actions/research";
import type { ResearchActionState } from "@/server/actions/types";
import type { ResearchFactField } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { ActionFeedback } from "./action-feedback";

const initial: ResearchActionState = { status: "idle" };

/**
 * Copies one extracted value into the staff-curated fact through the EXISTING audited fact edit
 * (updateFactAction): it replaces the current curated value and its sources, and is saved as
 * UNVERIFIED. Verification still only changes through the separate verification form.
 */
export function PromoteExtractedValueForm({
  projectId,
  field,
  values,
  source,
  label,
}: {
  projectId: string;
  field: ResearchFactField;
  values: string[];
  source: { sourceId: string; url: string; observedAt: string; documentDate: string | null; note: string };
  label: string;
}) {
  const [state, formAction, pending] = useActionState(updateFactAction, initial);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="status" value="known" />
      {values.map((v, i) => (
        <input key={i} type="hidden" name="value" value={v} />
      ))}
      <input type="hidden" name="sources[0].sourceId" value={source.sourceId} />
      <input type="hidden" name="sources[0].url" value={source.url} />
      <input type="hidden" name="sources[0].observedAt" value={source.observedAt} />
      {source.documentDate ? <input type="hidden" name="sources[0].documentDate" value={source.documentDate} /> : null}
      <input type="hidden" name="sources[0].note" value={source.note} />
      <Button type="submit" variant="link" size="sm" disabled={pending} className="h-auto">
        {pending ? "Saving…" : "Use as curated value (saved unverified)"}
        <span className="sr-only"> for {label}</span>
      </Button>
      <ActionFeedback state={state} />
    </form>
  );
}
