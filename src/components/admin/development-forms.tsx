"use client";

import { useActionState, useId } from "react";
import type { InfrastructureCategory, InfrastructureStage } from "@/domain/types";
import {
  createDevelopmentAction,
  requestDevelopmentResearchAction,
  reviewDevelopmentAction,
  updateDevelopmentAction,
} from "@/server/actions/developments";
import type { DevelopmentActionState } from "@/server/actions/types";
import { INFRA_CATEGORIES, INFRA_CATEGORY_LABEL, INFRA_STAGES, INFRA_STAGE_LABEL } from "@/locality/developments";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

const initial: DevelopmentActionState = { status: "idle" };

export function DevelopmentFeedback({ state }: { state: DevelopmentActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <Alert tone={state.autoUnpublished ? "warning" : "success"} role="status">
        {state.message}
      </Alert>
    );
  }
  return (
    <Alert tone={state.error === "conflict" ? "warning" : "danger"} role="alert">
      <AlertTitle>{state.message}</AlertTitle>
      {state.errors?.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {state.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {state.error === "conflict" ? (
        <p>
          <a href="">Reload this page</a>
        </p>
      ) : null}
      {state.error === "unauthenticated" ? (
        <p>
          <a href="/admin/login">Sign in again</a>
        </p>
      ) : null}
    </Alert>
  );
}

export function ResearchDevelopmentsForm({ localityId, localityName, disabled }: { localityId: string; localityName: string; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(requestDevelopmentResearchAction, initial);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="localityId" value={localityId} />
      <DevelopmentFeedback state={state} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Queuing…" : "Research area developments"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Automated web search for planned infrastructure within about 5 km of {localityName}. Results are unverified drafts: nothing is shown to
        buyers until staff review and publish it. Uses the shared daily research limit.
      </p>
    </form>
  );
}

export interface DevelopmentDraft {
  id?: string;
  version?: number;
  name: string;
  category: InfrastructureCategory;
  stage: InfrastructureStage;
  authority: string;
  expectedCompletion: string;
  announcedDate: string;
  localityIds: string[];
  lat: string;
  lng: string;
  locationPrecision: "exact" | "approximate";
  sourceUrl: string;
  sourceObservedAt: string; // YYYY-MM-DD
}

export function DevelopmentFieldsForm({
  mode,
  draft,
  localities,
}: {
  mode: "create" | "edit";
  draft: DevelopmentDraft;
  localities: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(mode === "create" ? createDevelopmentAction : updateDevelopmentAction, initial);
  const uid = useId();
  const f = (name: string) => `${uid}-${name}`;
  return (
    <form action={formAction} className="space-y-3">
      {draft.id ? <input type="hidden" name="id" value={draft.id} /> : null}
      {draft.version ? <input type="hidden" name="version" value={draft.version} /> : null}
      <DevelopmentFeedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={f("name")}>Name (as the source writes it)</Label>
          <Input id={f("name")} name="name" defaultValue={draft.name} required maxLength={120} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("category")}>Type</Label>
          <Select id={f("category")} name="category" defaultValue={draft.category}>
            {INFRA_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {INFRA_CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("stage")}>Stage</Label>
          <Select id={f("stage")} name="stage" defaultValue={draft.stage}>
            {INFRA_STAGES.map((s) => (
              <option key={s} value={s}>
                {INFRA_STAGE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("authority")}>Authority{mode === "create" ? " (required)" : ""}</Label>
          <Input id={f("authority")} name="authority" defaultValue={draft.authority} maxLength={80} placeholder="e.g. BMRCL" required={mode === "create"} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("expected")}>Expected completion, as declared</Label>
          <Input id={f("expected")} name="expectedCompletion" defaultValue={draft.expectedCompletion} maxLength={40} placeholder="e.g. December 2027" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={f("url")}>Authority / source page (https, required)</Label>
          <Input id={f("url")} name="sourceUrl" type="url" defaultValue={draft.sourceUrl} required placeholder="https://" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("observed")}>Date seen on the source</Label>
          <Input id={f("observed")} name="sourceObservedAt" type="date" defaultValue={draft.sourceObservedAt} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("announced")}>Announced on (optional)</Label>
          <Input id={f("announced")} name="announcedDate" type="date" defaultValue={draft.announcedDate} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={f("localities")}>Localities served</Label>
          <Select id={f("localities")} name="localityIds" multiple defaultValue={draft.localityIds} className="h-28">
            {localities.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("lat")}>Latitude (optional)</Label>
          <Input id={f("lat")} name="lat" inputMode="decimal" defaultValue={draft.lat} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("lng")}>Longitude (optional)</Label>
          <Input id={f("lng")} name="lng" inputMode="decimal" defaultValue={draft.lng} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={f("precision")}>Location precision</Label>
          <Select id={f("precision")} name="locationPrecision" defaultValue={draft.locationPrecision}>
            <option value="approximate">Approximate</option>
            <option value="exact">Exact</option>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Saved as unverified. Record only what the source states; never add price or return claims. A changed declared date is added to the
        slip history.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : mode === "create" ? "Add development" : "Save changes"}
      </Button>
    </form>
  );
}

export function DevelopmentReviewForm({
  id,
  version,
  action,
  label,
  variant = "secondary",
  withVerification,
  withNote,
}: {
  id: string;
  version: number;
  action: "publish" | "unpublish" | "reject" | "restore";
  label: string;
  variant?: "primary" | "secondary" | "ghost";
  withVerification?: boolean;
  withNote?: boolean;
}) {
  const [state, formAction, pending] = useActionState(reviewDevelopmentAction, initial);
  const uid = useId();
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="action" value={action} />
      <DevelopmentFeedback state={state} />
      {withVerification ? (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-v`}>Verification when publishing</Label>
          <Select id={`${uid}-v`} name="verification" defaultValue="unverified">
            <option value="unverified">Unverified (reviewed for publishing only)</option>
            <option value="source_confirmed">Source confirmed (I checked the authority page)</option>
          </Select>
        </div>
      ) : null}
      {withNote ? (
        <div className="space-y-1">
          <Label htmlFor={`${uid}-n`}>Reason (optional)</Label>
          <Input id={`${uid}-n`} name="note" maxLength={1000} />
        </div>
      ) : null}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? "Saving…" : label}
      </Button>
    </form>
  );
}
