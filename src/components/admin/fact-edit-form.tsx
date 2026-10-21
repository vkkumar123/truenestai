"use client";

import { useActionState, useState } from "react";
import { updateFactAction } from "@/server/actions/research";
import type { ResearchActionState } from "@/server/actions/types";
import type { ResearchFactField } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ActionFeedback } from "./action-feedback";

export interface SourceDraft {
  sourceId: string;
  url: string;
  observedAt: string;
  documentDate: string;
  note: string;
}

const MAX_SOURCE_ROWS = 3;
const initial: ResearchActionState = { status: "idle" };
const blank: SourceDraft = { sourceId: "", url: "", observedAt: "", documentDate: "", note: "" };

export function FactEditForm({
  projectId,
  field,
  label,
  initialStatus,
  initialValue,
  initialSources,
  nowIso,
  statusOptions,
}: {
  projectId: string;
  field: ResearchFactField;
  label: string;
  initialStatus: "known" | "unknown";
  /** Text form of the current value (RERA numbers one per line). */
  initialValue: string;
  initialSources: SourceDraft[];
  /** Request time, used as the default observed date for a first source. */
  nowIso: string;
  /** For constructionStatus: options for the value select. */
  statusOptions?: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(updateFactAction, initial);
  const [status, setStatus] = useState(initialStatus);
  const [value, setValue] = useState(initialValue);
  const [sources, setSources] = useState<SourceDraft[]>(() => {
    const rows = initialSources.slice(0, MAX_SOURCE_ROWS);
    if (rows.length === 0) rows.push({ ...blank, observedAt: nowIso });
    while (rows.length < MAX_SOURCE_ROWS) rows.push({ ...blank });
    return rows;
  });
  const setSource = (i: number, k: keyof SourceDraft, v: string) =>
    setSources((prev) => prev.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const id = (s: string) => `${field}-${s}`;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="field" value={field} />

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Status</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(["known", "unknown"] as const).map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="radio" name="status" value={s} checked={status === s} onChange={() => setStatus(s)} className="accent-primary" />
              {s === "known" ? "Known (value found)" : "Unknown (looked, not found)"}
            </label>
          ))}
        </div>
      </fieldset>

      {status === "known" ? (
        <div className="space-y-1.5">
          <Label htmlFor={id("value")}>{label}</Label>
          {field === "constructionStatus" ? (
            <Select id={id("value")} name="value" value={value} onChange={(e) => setValue(e.target.value)} required>
              <option value="">Choose a status</option>
              {(statusOptions ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : field === "reraNumbers" ? (
            <>
              <Textarea id={id("value")} name="value" rows={3} value={value} onChange={(e) => setValue(e.target.value)} aria-describedby={id("value-hint")} />
              <p id={id("value-hint")} className="text-xs text-muted-foreground">
                One registration reference per line, exactly as printed by the source (max 5).
              </p>
            </>
          ) : (
            <Input id={id("value")} name="value" value={value} onChange={(e) => setValue(e.target.value)} maxLength={field === "address" ? 300 : 100} />
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          The value will be cleared. Still add the source(s) you checked, so others know where we looked.
        </p>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Sources (at least one, https only)</legend>
        {sources.map((s, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-3">
            <p className="text-xs font-medium text-muted-foreground">Source {i + 1}{i > 0 ? " (optional)" : ""}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={id(`s${i}-id`)} className="text-xs">Source id</Label>
                <Input id={id(`s${i}-id`)} name={`sources[${i}].sourceId`} value={s.sourceId} onChange={(e) => setSource(i, "sourceId", e.target.value)} placeholder="e.g. k-rera" />
              </div>
              <div className="space-y-1">
                <Label htmlFor={id(`s${i}-url`)} className="text-xs">URL (https)</Label>
                <Input id={id(`s${i}-url`)} name={`sources[${i}].url`} type="url" inputMode="url" value={s.url} onChange={(e) => setSource(i, "url", e.target.value)} placeholder="https://…" />
              </div>
              <div className="space-y-1">
                <Label htmlFor={id(`s${i}-obs`)} className="text-xs">Observed at (ISO time)</Label>
                <div className="flex gap-2">
                  <Input id={id(`s${i}-obs`)} name={`sources[${i}].observedAt`} value={s.observedAt} onChange={(e) => setSource(i, "observedAt", e.target.value)} placeholder="2026-10-21T10:00:00.000Z" />
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSource(i, "observedAt", new Date().toISOString())}>
                    Now
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={id(`s${i}-doc`)} className="text-xs">Document date (optional)</Label>
                <Input id={id(`s${i}-doc`)} name={`sources[${i}].documentDate`} type="date" value={s.documentDate} onChange={(e) => setSource(i, "documentDate", e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={id(`s${i}-note`)} className="text-xs">Note (optional)</Label>
              <Input id={id(`s${i}-note`)} name={`sources[${i}].note`} maxLength={300} value={s.note} onChange={(e) => setSource(i, "note", e.target.value)} />
            </div>
          </div>
        ))}
      </fieldset>

      <p className="text-sm font-medium text-warning">Saving resets verification to Unverified.</p>
      <ActionFeedback state={state} />
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving…" : "Save fact"}
      </Button>
    </form>
  );
}
