"use client";

import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function RootError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <Alert tone="danger" className="mx-auto max-w-lg">
      <AlertTitle>Something went wrong</AlertTitle>
      <p className="mb-3">This page could not be loaded. Please try again.</p>
      <Button variant="secondary" size="sm" onClick={() => retry()}>
        Try again
      </Button>
    </Alert>
  );
}
