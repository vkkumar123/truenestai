import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

const alertVariants = cva("rounded-lg border p-4 text-sm [&_a]:underline", {
  variants: {
    tone: {
      neutral: "border-border bg-muted text-foreground",
      info: "border-info/30 bg-info/5 text-foreground",
      success: "border-success/30 bg-success/5 text-foreground",
      warning: "border-warning/40 bg-warning/5 text-foreground",
      danger: "border-danger/30 bg-danger/5 text-foreground",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type AlertProps = ComponentProps<"div"> & VariantProps<typeof alertVariants>;

export function Alert({ className, tone, role, ...props }: AlertProps) {
  return <div role={role ?? (tone === "danger" ? "alert" : undefined)} className={cn(alertVariants({ tone }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mb-1 font-semibold", className)} {...props} />;
}
