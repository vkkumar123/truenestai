import Link from "next/link";
import { House } from "lucide-react";

const NAV = [
  { href: "/projects", label: "Browse" },
  { href: "/compare", label: "Compare" },
  { href: "/request?type=buyer_assistance", label: "Get help" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <House aria-hidden="true" className="size-5 text-primary" />
          TrueNest
        </Link>
        <nav aria-label="Main">
          <ul className="flex items-center gap-1 text-sm">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="rounded-md px-3 py-2 font-medium text-foreground hover:bg-muted">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}
