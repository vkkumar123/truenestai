import { ResultsSkeleton } from "./results-skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <ResultsSkeleton />
    </div>
  );
}
