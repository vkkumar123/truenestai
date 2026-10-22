"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MAX_COMPARE } from "@/domain/limits";
import { Checkbox } from "@/components/ui/checkbox";
import { withCompare } from "./compare-url";


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
  const full = !checked && selected.length >= MAX_COMPARE;
  const id = `compare-${projectId}`;

  function onChange() {
    const next = checked ? selected.filter((x) => x !== projectId) : [...selected, projectId].slice(0, MAX_COMPARE);
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
          (max {MAX_COMPARE} selected)
        </span>
      ) : null}
    </div>
  );
}
