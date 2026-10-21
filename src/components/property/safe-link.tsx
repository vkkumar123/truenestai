import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { safeHttpsHref } from "./format";

/**
 * Outbound link for source/listing URLs. Renders a link only for https URLs; anything else is
 * shown as plain text so untrusted data can never become a javascript:/data:/http link.
 */
export function SafeExternalLink({
  url,
  children,
  srLabel = "(opens in a new tab)",
  className,
}: {
  url: string | null | undefined;
  children?: ReactNode;
  srLabel?: string;
  className?: string;
}) {
  const href = safeHttpsHref(url);
  if (!href) {
    return url ? (
      <span className={cn("break-all text-muted-foreground", className)}>
        {children ?? url} <span className="text-xs">(link not shown: not a secure https address)</span>
      </span>
    ) : null;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn("inline-flex items-center gap-1 break-all text-primary underline", className)}>
      {children ?? url}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">{srLabel}</span>
    </a>
  );
}
