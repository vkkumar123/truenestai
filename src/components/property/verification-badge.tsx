import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, Scale } from "lucide-react";
import type { VerificationState } from "@/domain/types";
import { Badge } from "@/components/ui/badge";
import { VERIFICATION_HELP, VERIFICATION_LABEL } from "./format";

const TONE = {
  unverified: "neutral",
  source_confirmed: "info",
  reviewed: "success",
  disputed: "warning",
  requires_professional_review: "warning",
} as const;

const ICON = {
  unverified: CircleDashed,
  source_confirmed: CheckCircle2,
  reviewed: CheckCircle2,
  disputed: AlertTriangle,
  requires_professional_review: Scale,
} as const;

export function VerificationBadge({ state }: { state: VerificationState }) {
  const Icon = ICON[state] ?? HelpCircle;
  return (
    <Badge tone={TONE[state]} title={VERIFICATION_HELP[state]}>
      <Icon aria-hidden="true" />
      {VERIFICATION_LABEL[state]}
    </Badge>
  );
}

/** Neutral badge for a value we have not found. Deliberately not styled as a warning. */
export function UnknownBadge({ children = "Not yet found" }: { children?: ReactNode }) {
  return (
    <Badge tone="outline" className="border-dashed text-muted-foreground">
      <HelpCircle aria-hidden="true" />
      {children}
    </Badge>
  );
}
