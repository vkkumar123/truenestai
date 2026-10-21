"use client";

import { useActionState } from "react";
import { changeVerificationAction } from "@/server/actions/research";
import type { ResearchActionState } from "@/server/actions/types";
import type { ResearchFactField } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ActionFeedback } from "./action-feedback";

const initial: ResearchActionState = { status: "idle" };

/** Offers only the transitions the server says this role may make. */
export function VerificationForm({
  projectId,
  field,
  options,
}: {
  projectId: string;
  field: ResearchFactField;
  options: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(changeVerificationAction, initial);
  const id = (s: string) => `${field}-v-${s}`;
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="field" value={field} />
      <div className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <div className="space-y-1">
          <Label htmlFor={id("to")} className="text-xs">Change verification to</Label>
          <Select id={id("to")} name="to" defaultValue={options[0]?.value}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("note")} className="text-xs">Note (optional)</Label>
          <Input id={id("note")} name="note" maxLength={1000} placeholder="What did you check?" />
        </div>
      </div>
      <ActionFeedback state={state} />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending ? "Updating…" : "Update verification"}
      </Button>
    </form>
  );
}
