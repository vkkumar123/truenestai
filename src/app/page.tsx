import Link from "next/link";
import { FileSearch, Scale, ShieldCheck } from "lucide-react";
import { listLocalities } from "@/config/markets";
import { buttonVariants } from "@/components/ui/button";
import { LocalitySearch } from "@/components/site/locality-search";

export default function Home() {
  const localities = listLocalities({ activeOnly: true })
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="space-y-10">
      <section className="space-y-4 pt-2 sm:pt-6">
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Know what is known about a project — and what isn&rsquo;t — before you share your details.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          TrueNest shows each fact about North Bengaluru residential projects with its source, the date we saw it and how far it
          has been checked. Browse and compare without signing up.
        </p>
        <LocalitySearch localities={localities} />
        <p className="text-sm">
          <Link href="/projects" className={buttonVariants({ variant: "link" })}>
            Or browse all projects
          </Link>
        </p>
      </section>

      <section aria-labelledby="how" className="grid gap-4 sm:grid-cols-3">
        <h2 id="how" className="sr-only">
          How TrueNest works
        </h2>
        {[
          { icon: FileSearch, title: "Sources on every fact", body: "Each fact links to where it came from and when it was observed." },
          { icon: ShieldCheck, title: "Unknowns stay visible", body: "If we have not found something, we say “Not yet found” — never a guess." },
          { icon: Scale, title: "Professional review flagged", body: "Title, encumbrance and approvals need a qualified professional. We mark them." },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-lg border border-border bg-surface p-4">
            <Icon aria-hidden="true" className="mb-2 size-5 text-primary" />
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
