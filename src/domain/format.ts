// Client-safe display formatters.

/** Indian-style rupee amount: ₹1.25 Cr, ₹85.0 L, or ₹12,345. */
export function formatInr(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}
