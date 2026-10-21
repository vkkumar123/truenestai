"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createProjectAction } from "@/server/actions/research";
import type { ResearchActionState } from "@/server/actions/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ActionFeedback } from "./action-feedback";

const initial: ResearchActionState = { status: "idle" };

export function NewProjectForm({
  localities,
  developers,
}: {
  localities: { id: string; name: string }[];
  developers: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(createProjectAction, initial);
  const router = useRouter();
  const [f, setF] = useState({ name: "", developerId: "", developerName: "", localityId: "", lat: "", lng: "" });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    if (state.status === "success") router.push(`/admin/projects/${encodeURIComponent(state.projectId)}`);
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-4 rounded-lg border border-border bg-surface p-4">
      <ActionFeedback state={state} />
      {state.status === "success" ? (
        <p className="text-sm">
          <Link href={`/admin/projects/${encodeURIComponent(state.projectId)}`}>Open the project</Link>
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="np-name">Project name</Label>
        <Input id="np-name" name="name" required minLength={3} maxLength={120} value={f.name} onChange={(e) => set("name", e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="np-devid">Developer</Label>
        <Select id="np-devid" name="developerId" value={f.developerId} onChange={(e) => set("developerId", e.target.value)}>
          <option value="">New developer (enter the name below)</option>
          {developers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">Existing developers are never matched by name — pick one here to reuse it.</p>
      </div>
      {f.developerId === "" ? (
        <div className="space-y-1.5">
          <Label htmlFor="np-dev">New developer name</Label>
          <Input id="np-dev" name="developerName" required minLength={2} maxLength={120} value={f.developerName} onChange={(e) => set("developerName", e.target.value)} />
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="np-loc">Locality</Label>
        <Select id="np-loc" name="localityId" required value={f.localityId} onChange={(e) => set("localityId", e.target.value)}>
          <option value="">Choose a locality</option>
          {localities.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-medium">Location (optional — give both or neither)</legend>
        <div className="space-y-1.5">
          <Label htmlFor="np-lat">Latitude</Label>
          <Input id="np-lat" name="lat" inputMode="decimal" value={f.lat} onChange={(e) => set("lat", e.target.value)} placeholder="13.03" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="np-lng">Longitude</Label>
          <Input id="np-lng" name="lng" inputMode="decimal" value={f.lng} onChange={(e) => set("lng", e.target.value)} placeholder="77.59" />
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">New projects start unpublished, with every fact &ldquo;Not yet found&rdquo;.</p>
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}
