"use client";

import { useActionState } from "react";
import { assignLeadAction } from "@/server/actions/leads";
import type { AssignLeadState } from "@/server/actions/types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

const initial: AssignLeadState = { status: "idle" };

export function AssignLeadForm({
  leadId,
  assignedTo,
  staff,
}: {
  leadId: string;
  assignedTo: string | null;
  staff: { userId: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(assignLeadAction, initial);
  const selectId = `assign-${leadId}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="leadId" value={leadId} />
      <label htmlFor={selectId} className="sr-only">
        Assign to
      </label>
      <Select id={selectId} name="assigneeId" defaultValue={assignedTo ?? ""} className="h-8 w-auto max-w-48 text-xs">
        <option value="">Unassigned</option>
        {staff.map((s) => (
          <option key={s.userId} value={s.userId}>
            {s.label}
          </option>
        ))}
      </Select>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Assign"}
      </Button>
      <span aria-live="polite" className={state.status === "error" ? "text-xs text-danger" : "text-xs text-success"}>
        {state.status === "idle" ? "" : state.message}
      </span>
    </form>
  );
}
