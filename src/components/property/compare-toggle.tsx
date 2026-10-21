"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Checkbox } from "@/components/ui/checkbox";

export const MAX_COMPARE_UI = 4;

/** Builds a URL with the compare selection kept in the `compare` query param. */
export function withCompare(pathname: string, query: Record<string, string | undefined>, ids: string[]): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) sp.set(k, v);
  if (ids.length) sp.set("compare", ids.join(","));
  const s = sp.toString();
  return s ? `${pathname}?${s}` : pathname;
}

export function CompareToggle({
  projectId,
  projectName,
  selected,
  query,
}: {
  projectId: string;
  projectName: string;
  selected: string[];
  query: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const checked = selected.includes(projectId);
  const full = !checked && selected.length >= MAX_COMPARE_UI;
  const id = `compare-${projectId}`;

  function onChange() {
    const next = checked ? selected.filter((x) => x !== projectId) : [...selected, projectId].slice(0, MAX_COMPARE_UI);
    startTransition(() => router.replace(withCompare("/projects", query, next), { scroll: false }));
  }

  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        disabled={full || pending}
        onChange={onChange}
        aria-describedby={full ? `${id}-full` : undefined}
      />
      <label htmlFor={id} className="cursor-pointer select-none">
        Compare <span className="sr-only">{projectName}</span>
      </label>
      {full ? (
        <span id={`${id}-full`} className="text-xs text-muted-foreground">
          (max {MAX_COMPARE_UI} selected)
        </span>
      ) : null}
    </div>
  );
}
