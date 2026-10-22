"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { DocumentUploadResponse } from "@/server/http/document-upload";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // must match the server limit (15 MB)
const ACCEPT = ".pdf,.png,.jpg,.jpeg";
const ALLOWED_EXT = /\.(pdf|png|jpe?g)$/i;

export const DOCUMENT_KIND_LABELS = {
  approval: "Approval",
  brochure: "Brochure",
  rera_certificate: "RERA certificate",
  plan: "Plan",
  other: "Other",
} as const;

export function DocumentUploadForm({
  projectId,
  sourceOptions,
}: {
  projectId: string;
  sourceOptions: { id: string; name: string }[];
}) {
  const [result, setResult] = useState<DocumentUploadResponse | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const file = fileRef.current?.files?.[0];
    let err: string | null = null;
    if (!file) err = "Choose a file to upload.";
    else if (!ALLOWED_EXT.test(file.name)) err = "Only PDF, PNG or JPEG files can be uploaded.";
    else if (file.size > MAX_UPLOAD_BYTES) err = "The file is larger than 15 MB.";
    else if (file.size === 0) err = "The file is empty.";
    setClientError(err);
    setResult(null);
    if (err) return;
    setPending(true);
    try {
      // Staff route handler (same-origin; session cookie sent automatically).
      const res = await fetch("/api/staff/documents", { method: "POST", body: new FormData(form) });
      let body: DocumentUploadResponse;
      try {
        body = (await res.json()) as DocumentUploadResponse;
      } catch {
        body = { ok: false, error: "unavailable", message: `Upload failed (HTTP ${res.status}).` };
      }
      setResult(body);
      if (body.ok) {
        form.reset();
        router.refresh();
      }
    } catch {
      setResult({ ok: false, error: "unavailable", message: "Network error. Please try again." });
    } finally {
      setPending(false);
    }
  }

  const id = (s: string) => `doc-${s}`;
  return (
    <form onSubmit={onSubmit} encType="multipart/form-data" className="space-y-3">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={id("title")} className="text-xs">Title</Label>
          <Input id={id("title")} name="title" required maxLength={200} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("key")} className="text-xs">Document key</Label>
          <Input id={id("key")} name="documentKey" required maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="e.g. site-plan" aria-describedby={id("key-hint")} />
          <p id={id("key-hint")} className="text-xs text-muted-foreground">
            Lowercase with dashes. Uploading with an existing key adds a new version.
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("kind")} className="text-xs">Kind</Label>
          <Select id={id("kind")} name="kind" defaultValue="other">
            {Object.entries(DOCUMENT_KIND_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("date")} className="text-xs">Document date (optional)</Label>
          <Input id={id("date")} name="documentDate" type="date" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("src")} className="text-xs">Source</Label>
          <Select id={id("src")} name="sourceId" required defaultValue="">
            <option value="">Choose a source</option>
            {sourceOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.id} — {o.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("url")} className="text-xs">Source URL (optional, https)</Label>
          <Input id={id("url")} name="sourceUrl" type="url" inputMode="url" placeholder="https://…" />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("file")} className="text-xs">File (PDF, PNG or JPEG, up to 15 MB)</Label>
        <input ref={fileRef} id={id("file")} name="file" type="file" accept={ACCEPT} required className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5" />
      </div>
      {clientError ? (
        <Alert tone="danger" role="alert">
          {clientError}
        </Alert>
      ) : result?.ok ? (
        <Alert tone="success" role="status">
          Document uploaded (version {result.version}).
        </Alert>
      ) : result && !result.ok ? (
        <Alert tone="danger" role="alert">
          <AlertTitle>{result.message}</AlertTitle>
          {result.errors?.length ? (
            <ul className="list-disc pl-5">
              {result.errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
          {result.error === "unauthenticated" ? (
            <p>
              <a href="/admin/login">Sign in again</a>
            </p>
          ) : null}
        </Alert>
      ) : null}
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Uploading…" : "Upload document"}
      </Button>
    </form>
  );
}
