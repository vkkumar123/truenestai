import type { ComponentProps } from "react";
import { cn } from "./cn";

const field =
  "w-full rounded-md border border-input bg-surface px-3 text-sm text-foreground placeholder:text-muted-foreground disabled:opacity-50 aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "min-h-24 py-2", className)} {...props} />;
}
