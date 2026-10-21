import { cacheLife } from "next/cache";
import { FlaskConical } from "lucide-react";
import { hasSampleData } from "@/server/services/projects";

/** True when the data currently served contains sample (fictional) records. */
async function sampleDataInUse(): Promise<boolean> {
  "use cache";
  cacheLife("hours");
  try {
    return await hasSampleData();
  } catch {
    return false;
  }
}

export async function SampleDataBanner() {
  if (!(await sampleDataInUse())) return null;
  return (
    <div role="note" className="border-b border-warning/40 bg-warning/10 text-sm text-foreground">
      <p className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5">
        <FlaskConical aria-hidden="true" className="size-4 shrink-0 text-warning" />
        <span>
          <strong className="font-semibold">Sample data</strong> — all projects shown are fictional.
        </span>
      </p>
    </div>
  );
}
