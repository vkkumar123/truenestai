import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">
        We could not find this page. If you followed a link to a project, it may not be published yet.
      </p>
      <Link href="/projects" className={buttonVariants()}>
        Browse projects
      </Link>
    </div>
  );
}
