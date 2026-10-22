import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function ProjectNotFound() {
  return (
    <div className="mx-auto max-w-lg space-y-4 py-12 text-center">
      <h1 className="text-2xl font-semibold">Project not found</h1>
      <p className="text-muted-foreground">This project does not exist or has not been published after review.</p>
      <Link href="/projects" className={buttonVariants()}>
        Browse projects
      </Link>
    </div>
  );
}
