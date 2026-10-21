"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import type { LeadRequestType } from "@/domain/types";
import { CONSENT_COPY, CONSENT_TEXT_VERSION } from "@/leads/consent";
import { submitLeadAction } from "@/server/actions/leads";
import type { SubmitLeadState } from "@/server/actions/types";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, Textarea } from "@/components/ui/input";
import { FieldError, Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface LeadFormProps {
  defaultRequestType: LeadRequestType;
  projectId: string | null;
  externalListingId: string | null;
  landingPath: string;
  utm: { utmSource?: string; utmMedium?: string; utmCampaign?: string };
  budgetBands: { value: string; label: string }[];
}

const initial: SubmitLeadState = { status: "idle" };

type Fields = {
  requestType: LeadRequestType;
  name: string;
  email: string;
  phone: string;
  preferredChannel: "email" | "phone" | "whatsapp";
  budgetBand: string;
  message: string;
  contactConsent: boolean;
  marketingConsent: boolean;
};

export function LeadForm(props: LeadFormProps) {
  const [state, formAction, pending] = useActionState(submitLeadAction, initial);
  // Controlled fields so values survive the automatic form reset after a failed submit.
  const [f, setF] = useState<Fields>({
    requestType: props.defaultRequestType,
    name: "",
    email: "",
    phone: "",
    preferredChannel: "email",
    budgetBand: "",
    message: "",
    contactConsent: false,
    marketingConsent: false,
  });
  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((prev) => ({ ...prev, [k]: v }));

  if (state.status === "success") {
    return (
      <Alert tone="success" role="status" className="space-y-3">
        <AlertTitle className="flex items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
          {state.message}
        </AlertTitle>
        <p>
          Your reference: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{state.leadId}</code>
        </p>
        <div>
          <p className="font-medium">What happens next</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>A TrueNest advisor will review your request and contact you using the channel you chose.</li>
            <li>For verification requests, we research the property and record each fact with its source before publishing.</li>
            <li>We never share your details with a developer without asking you first.</li>
          </ul>
        </div>
        <p className="text-muted-foreground">{CONSENT_COPY.withdrawal} Quote your reference when you contact us.</p>
        <Link href="/projects" className="text-sm">
          Back to browsing
        </Link>
      </Alert>
    );
  }

  const errors = state.status === "error" ? state.errors : {};
  const err = (k: string) => errors[k];
  const aria = (k: string) => (err(k) ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});
  const formError =
    state.status === "error"
      ? state.reason === "rate_limited"
        ? errors.form ?? "Too many requests. Please wait a few minutes and try again."
        : state.reason === "unavailable"
          ? errors.form ?? "We could not save your request. Please try again shortly."
          : errors.form ?? errors.projectId ?? errors.externalListingId ?? errors.consentTextVersion ?? errors.website ?? null
      : null;
  const hasFieldErrors = state.status === "error" && state.reason === "validation" && Object.keys(errors).length > 0;

  return (
    <form action={formAction} noValidate className="space-y-5">
      {formError ? (
        <Alert tone={state.status === "error" && state.reason === "validation" ? "danger" : "warning"} role="alert">
          <AlertTitle>
            {state.status === "error" && state.reason === "rate_limited"
              ? "Please slow down"
              : state.status === "error" && state.reason === "unavailable"
                ? "Service temporarily unavailable"
                : "Please check your request"}
          </AlertTitle>
          <p>{formError}</p>
        </Alert>
      ) : hasFieldErrors ? (
        <Alert tone="danger" role="alert">
          <p>Please correct the highlighted fields below.</p>
        </Alert>
      ) : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What do you need?</legend>
        {(
          [
            { v: "verification", label: "Request verification", help: "Ask TrueNest to research and verify this property." },
            { v: "buyer_assistance", label: "Buyer assistance", help: "Talk to an advisor about your search or a shortlist." },
          ] as const
        ).map((o) => (
          <label key={o.v} className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-surface p-3 has-[:checked]:border-primary">
            <input
              type="radio"
              name="requestType"
              value={o.v}
              checked={f.requestType === o.v}
              onChange={() => set("requestType", o.v)}
              className="mt-1 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.help}</span>
            </span>
          </label>
        ))}
        <FieldError id="requestType-error" message={err("requestType")} />
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="name">Your name</Label>
        <Input id="name" name="name" autoComplete="name" required maxLength={80} value={f.name} onChange={(e) => set("name", e.target.value)} {...aria("name")} />
        <FieldError id="name-error" message={err("name")} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" maxLength={254} value={f.email} onChange={(e) => set("email", e.target.value)} {...aria("email")} />
          <FieldError id="email-error" message={err("email")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Mobile number (India)</Label>
          <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={30} placeholder="+91 98xxxxxxxx" value={f.phone} onChange={(e) => set("phone", e.target.value)} {...aria("phone")} />
          <FieldError id="phone-error" message={err("phone")} />
        </div>
      </div>
      <p className="-mt-3 text-xs text-muted-foreground">Give an email address, a mobile number, or both.</p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="preferredChannel">How should we contact you?</Label>
          <Select id="preferredChannel" name="preferredChannel" value={f.preferredChannel} onChange={(e) => set("preferredChannel", e.target.value as Fields["preferredChannel"])} {...aria("preferredChannel")}>
            <option value="email">Email</option>
            <option value="phone">Phone call</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
          <FieldError id="preferredChannel-error" message={err("preferredChannel")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budgetBand">Budget (optional)</Label>
          <Select id="budgetBand" name="budgetBand" value={f.budgetBand} onChange={(e) => set("budgetBand", e.target.value)} {...aria("budgetBand")}>
            <option value="">Prefer not to say</option>
            {props.budgetBands.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </Select>
          <FieldError id="budgetBand-error" message={err("budgetBand")} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="message">Message (optional)</Label>
        <Textarea id="message" name="message" maxLength={1000} rows={4} value={f.message} onChange={(e) => set("message", e.target.value)} {...aria("message")} />
        <FieldError id="message-error" message={err("message")} />
      </div>

      <input type="hidden" name="projectId" value={props.projectId ?? ""} />
      <input type="hidden" name="externalListingId" value={props.externalListingId ?? ""} />
      <input type="hidden" name="landingPath" value={props.landingPath} />
      <input type="hidden" name="utmSource" value={props.utm.utmSource ?? ""} />
      <input type="hidden" name="utmMedium" value={props.utm.utmMedium ?? ""} />
      <input type="hidden" name="utmCampaign" value={props.utm.utmCampaign ?? ""} />
      <input type="hidden" name="consentTextVersion" value={CONSENT_TEXT_VERSION} />

      {/* Honeypot: hidden from people and assistive tech; bots tend to fill it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div className="space-y-3 rounded-md border border-border bg-muted/50 p-3">
        <div className="space-y-1">
          <div className="flex items-start gap-3">
            <Checkbox id="contactConsent" name="contactConsent" required checked={f.contactConsent} onChange={(e) => set("contactConsent", e.target.checked)} {...aria("contactConsent")} />
            <Label htmlFor="contactConsent" className="font-normal">
              {CONSENT_COPY.contactConsent} <span className="text-danger">(required)</span>
            </Label>
          </div>
          <FieldError id="contactConsent-error" message={err("contactConsent")} />
        </div>
        <div className="flex items-start gap-3">
          <Checkbox id="marketingConsent" name="marketingConsent" checked={f.marketingConsent} onChange={(e) => set("marketingConsent", e.target.checked)} />
          <Label htmlFor="marketingConsent" className="font-normal">
            {CONSENT_COPY.marketingConsent}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">{CONSENT_COPY.withdrawal}</p>
      </div>

      <p className="text-xs text-muted-foreground">{CONSENT_COPY.commercialDisclosure}</p>

      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Sending…" : "Send request"}
      </Button>
    </form>
  );
}
