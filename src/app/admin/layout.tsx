import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminNav } from "@/components/admin/admin-nav";

export const metadata: Metadata = {
  title: "Staff",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<div className="h-10" aria-hidden="true" />}>
        <AdminNav />
      </Suspense>
      {children}
    </div>
  );
}
