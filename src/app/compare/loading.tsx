export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-6">
      <span className="sr-only">Loading comparison…</span>
      <div className="h-8 w-56 animate-pulse rounded bg-muted" />
      <div className="h-96 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
