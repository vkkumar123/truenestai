// The project attributes requested from an uploaded registration document (spec 02 catalogue,
// 0006 + 0007). Value kinds mirror fact_attributes (a unit test compares them with FACT_ATTRIBUTES).

export type ExtractionValueKind = "text" | "number" | "date" | "json";

export interface ExtractionAttribute {
  attribute: string;
  kind: ExtractionValueKind;
  /** Staff-facing label. */
  label: string;
  /** What to look for, shown to the model. */
  instruction: string;
  /** json attributes collect several printed items (one output line each). */
  multi?: boolean;
  /** number attributes: integer only, and the allowed range. */
  integer?: boolean;
  range?: [number, number];
}

export const EXTRACTION_ATTRIBUTES: readonly ExtractionAttribute[] = [
  { attribute: "rera_numbers", kind: "json", multi: true, label: "RERA registration number", instruction: "each RERA registration number of the project (one line per number)" },
  { attribute: "project_name", kind: "text", label: "Project name", instruction: "the project's name" },
  { attribute: "promoter_name", kind: "text", label: "Promoter (company)", instruction: "the promoter's company or organisation name (never a person's name)" },
  { attribute: "address", kind: "text", label: "Address / site location", instruction: "the project's address or site location" },
  { attribute: "rera_status", kind: "text", label: "Registration status", instruction: "the registration status, if printed (for example registered, revoked, lapsed)" },
  { attribute: "rera_registration_date", kind: "date", label: "Registration date", instruction: "the date of registration" },
  { attribute: "rera_completion_date", kind: "date", label: "Completion date declared to RERA", instruction: "the proposed or declared completion date" },
  { attribute: "rera_extension_count", kind: "number", integer: true, range: [0, 20], label: "Extensions granted", instruction: "the number of extensions granted, only if printed as a number" },
  { attribute: "land_area_acres", kind: "number", range: [0.01, 10000], label: "Land area (acres)", instruction: "the total land area, only if printed in acres" },
  { attribute: "total_units", kind: "number", integer: true, range: [1, 50000], label: "Number of units", instruction: "the total number of units or apartments" },
  { attribute: "towers", kind: "number", integer: true, range: [1, 200], label: "Towers / blocks", instruction: "the number of towers, blocks or buildings" },
  { attribute: "floors", kind: "number", integer: true, range: [1, 200], label: "Floors", instruction: "the number of floors (the highest, if several)" },
  { attribute: "plan_approvals", kind: "json", multi: true, label: "Approvals", instruction: "each plan sanction or other approval listed, with its reference as printed (one line each)" },
  { attribute: "bank_approvals", kind: "json", multi: true, label: "Bank approvals", instruction: "each bank stated to have approved the project (one line each)" },
  { attribute: "khata_type", kind: "text", label: "Khata type", instruction: "the khata type, if printed" },
  { attribute: "oc_status", kind: "text", label: "Occupancy certificate", instruction: "the occupancy certificate status or reference, if printed" },
];

export function getExtractionAttribute(attribute: string): ExtractionAttribute | undefined {
  return EXTRACTION_ATTRIBUTES.find((a) => a.attribute === attribute);
}
