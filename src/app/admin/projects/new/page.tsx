import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { listLocalities } from "@/config/markets";
import { listDevelopers } from "@/server/services/research";
import { NewProjectForm } from "@/components/admin/new-project-form";
import { requireStaffPage } from "../../_lib/session";

export const metadata: Metadata = { title: "New project", robots: { index: false, follow: false } };

export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <p className="text-sm">
        <Link href="/admin/projects" className="underline">
          ← Research projects
        </Link>
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">New project</h1>
      <Suspense fallback={<div aria-busy="true" className="h-80 animate-pulse rounded-lg bg-muted" />}>
        <NewProjectContent />
      </Suspense>
    </div>
  );
}

async function NewProjectContent() {
  await requireStaffPage("/admin/projects/new");
  const localities = listLocalities({ activeOnly: true })
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const developers = (await listDevelopers())
    .map((d) => ({ id: d.id, name: d.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return <NewProjectForm localities={localities} developers={developers} />;
}
