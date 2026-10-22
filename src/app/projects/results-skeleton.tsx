export function ResultsSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading projects…</span>
      <div className="h-32 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-64 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    </div>
  );
}
