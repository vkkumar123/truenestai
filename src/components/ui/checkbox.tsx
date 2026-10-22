import type { ComponentProps } from "react";
import { cn } from "./cn";

export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn("mt-0.5 size-4 shrink-0 rounded border-input accent-primary disabled:opacity-50", className)}
      {...props}
    />
  );
}
