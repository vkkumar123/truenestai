export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading project…</span>
      <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      <div className="h-9 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted" />
      <div className="h-64 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
