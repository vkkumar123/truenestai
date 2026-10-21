"use client";

import { useActionState } from "react";
import { updateLeadStatusAction } from "@/server/actions/leads";
import type { UpdateLeadStatusState } from "@/server/actions/types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

const initial: UpdateLeadStatusState = { status: "idle" };

export function LeadStatusForm({ leadId, options }: { leadId: string; options: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(updateLeadStatusAction, initial);
  if (!options.length) return <span className="text-xs text-muted-foreground">No further changes</span>;
  const selectId = `status-${leadId}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label htmlFor={selectId} className="sr-only">
        New status
      </label>
      <Select id={selectId} name="status" defaultValue={options[0].value} className="h-8 w-auto text-xs">
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value === "withdrawn" ? `${o.label} (erases personal data)` : o.label}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Update"}
      </Button>
      <span aria-live="polite" className={state.status === "error" ? "text-xs text-danger" : "text-xs text-success"}>
        {state.status === "idle" ? "" : state.message}
        {state.status === "error" && state.unauthenticated ? (
          <>
            {" "}
            <a href="/admin/login" className="underline">
              Sign in again
            </a>
          </>
        ) : null}
      </span>
    </form>
  );
}
