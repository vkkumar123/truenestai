import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Staff",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="space-y-6">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">TrueNest staff area</p>
      {children}
    </div>
  );
}
