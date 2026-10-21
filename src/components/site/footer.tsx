import Link from "next/link";
import { CONSENT_COPY } from "@/leads/consent";

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t border-border bg-surface">
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-6 text-xs text-muted-foreground">
        <p>
          <strong className="font-semibold text-foreground">Commercial relationships and limits.</strong> {CONSENT_COPY.commercialDisclosure}
        </p>
        <p>
          RERA registration shows that a registration exists. It is not proof of clear title. Missing information is shown as
          &ldquo;Not yet found&rdquo; and is not a negative finding. Declared dates are not guarantees.
        </p>
        <p>
          TrueNest covers North Bengaluru only in this phase. <Link href="/projects" className="underline">Browse projects</Link>
          {" · "}
          <Link href="/request?type=buyer_assistance" className="underline">Get buyer assistance</Link>
        </p>
      </div>
    </footer>
  );
}
