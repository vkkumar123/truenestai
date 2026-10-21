import type { ReactNode } from "react";
import type { FactValue } from "@/domain/types";
import { NOT_YET_FOUND } from "./format";
import { SourcesList } from "./sources-list";
import { UnknownBadge, VerificationBadge } from "./verification-badge";

/** One fact: value (or "Not yet found"), verification state and sources. */
export function FactRow<T>({
  label,
  fact,
  render,
  hint,
}: {
  label: string;
  fact: FactValue<T>;
  render: (v: T) => ReactNode;
  hint?: string;
}) {
  const known = fact.status === "known" && fact.value !== null;
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-muted-foreground">
        {label}
        {hint ? <span className="block text-xs font-normal">{hint}</span> : null}
      </dt>
      <dd className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {known ? <span className="text-sm">{render(fact.value as T)}</span> : <span className="text-sm text-muted-foreground">{NOT_YET_FOUND}</span>}
          {known ? <VerificationBadge state={fact.verification} /> : <UnknownBadge />}
        </div>
        <SourcesList sources={fact.sources} />
      </dd>
    </div>
  );
}
