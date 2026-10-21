import type { ResearchActionState } from "@/server/actions/types";
import { Alert, AlertTitle } from "@/components/ui/alert";

/** Inline result of a research action: success message, or the error with its detail list. */
export function ActionFeedback({ state }: { state: ResearchActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <Alert tone="success" role="status">
        {state.message}
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
