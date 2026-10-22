import Link from "next/link";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { formatDate } from "@/components/property/format";

export type ResearchNoticeState =
  | { status: "researching"; queryText: string }
  | { status: "searched_none"; queryText: string; searchedAt: string }
  | { status: "unavailable"; queryText: string };

/** Honest copy for on-demand research. None of these states says or implies "no projects exist". */
export function ResearchNotice({ state }: { state: ResearchNoticeState }) {
  if (state.status === "researching") {
    return (
      <Alert tone="info" role="status">
        <AlertTitle>We’re researching “{state.queryText}” now</AlertTitle>
        <p>
          Results usually appear within a few minutes; refresh this page to check. Anything we find comes from public web pages
          and is labelled unverified until TrueNest checks it.
        </p>
      </Alert>
    );
  }
  if (state.status === "searched_none") {
    return (
      <Alert role="status">
        <AlertTitle>
          We searched public web sources for “{state.queryText}” on {formatDate(state.searchedAt)}
        </AlertTitle>
        <p>
          We found nothing we could cite reliably. That does not mean no projects exist.{" "}
          <Link href="/request?type=buyer_assistance">Ask us to look</Link>.
        </p>
      </Alert>
    );
  }
  return (
    <Alert role="status">
      <AlertTitle>We can’t research “{state.queryText}” automatically right now</AlertTitle>
      <p>
        Please try again later, or <Link href="/request?type=buyer_assistance">ask us to look</Link>. This does not mean no
        projects exist.
      </p>
    </Alert>
  );
}
