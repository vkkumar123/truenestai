import { cacheLife } from "next/cache";
import { connection } from "next/server";
import { FlaskConical } from "lucide-react";
import { hasSampleData } from "@/server/services/projects";

/**
 * True when the data currently served contains sample (fictional) records. Keyed by backend so
 * an entry computed under one data backend is never reused under another.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the argument is the cache key only
async function sampleDataInUse(_backend: string): Promise<boolean> {
  "use cache";
  cacheLife("hours");
  try {
    return await hasSampleData();
  } catch {
    return false;
  }
}

export async function SampleDataBanner() {
  // Request time only: the image is built without runtime env (fixture by default), so a
  // prerendered banner would claim sample data on a real-data deployment.
  await connection();
  if (!(await sampleDataInUse(process.env.DATA_BACKEND ?? "fixture"))) return null;
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
