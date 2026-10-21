"use client";

import Link from "next/link";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function ProjectsError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Alert tone="danger" className="mx-auto max-w-lg">
      <AlertTitle>We could not load projects</AlertTitle>
      <p className="mb-3">Please try again. If this keeps happening, come back a little later.</p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/" className="self-center text-sm">
          Go home
        </Link>
      </div>
    </Alert>
  );
}
