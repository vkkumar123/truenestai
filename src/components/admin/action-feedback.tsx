import type { ResearchActionState } from "@/server/actions/types";
import { Alert, AlertTitle } from "@/components/ui/alert";

export const AUTO_UNPUBLISHED_NOTICE =
  "Project was unpublished because it no longer meets the publish rules. Re-verify and publish again.";
export const CONFLICT_NOTICE = "This fact changed since you loaded it — reload and review again.";

/** Inline result of a research action: success (with auto-unpublish notice), or the error and its details. */
export function ActionFeedback({ state }: { state: ResearchActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <div className="space-y-2">
        <Alert tone="success" role="status">
          {state.autoUnpublished ? state.message.split(" The project no longer")[0] : state.message}
        </Alert>
        {state.autoUnpublished ? (
          <Alert tone="warning" role="alert" className="border-2">
            <AlertTitle>Project unpublished</AlertTitle>
            <p>{AUTO_UNPUBLISHED_NOTICE}</p>
          </Alert>
        ) : null}
      </div>
    );
  }
  if (state.error === "conflict") {
    return (
      <Alert tone="warning" role="alert">
        <AlertTitle>{CONFLICT_NOTICE}</AlertTitle>
        <p>
          {/* A full page load fetches the latest fact and its version. */}
          <a href="">Reload this page</a>
        </p>
      </Alert>
    );
  }
  return (
    <Alert tone="danger" role="alert">
      <AlertTitle>{state.message}</AlertTitle>
      {state.errors?.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {state.error === "unauthenticated" ? (
        <p>
          <a href="/admin/login">Sign in again</a>
        </p>
      ) : null}
    </Alert>
  );
}
