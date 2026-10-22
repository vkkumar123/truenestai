// Client-safe human labels (no zod, no server imports).
import type { LeadRequestType, LeadStatus } from "@/domain/types";
import type { BudgetBand } from "./validation";

export const BUDGET_BAND_LABELS: Record<BudgetBand, string> = {
  under_50l: "Under ₹50 lakh",
  "50l_1cr": "₹50 lakh – ₹1 crore",
  "1cr_1_5cr": "₹1 – ₹1.5 crore",
  "1_5cr_2cr": "₹1.5 – ₹2 crore",
  "2cr_3cr": "₹2 – ₹3 crore",
  above_3cr: "Above ₹3 crore",
};

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  closed: "Closed",
  withdrawn: "Withdrawn",
};

export const REQUEST_TYPE_LABELS: Record<LeadRequestType, string> = {
  verification: "Verify a property",
  buyer_assistance: "Help me find a home",
};
