// Staff fact-edit input validation (M3, D12). Pure; no I/O.
//
// Input shape accepted by `parseFactEdit(raw)`:
//   - a FormData-like object (anything with `entries()`), or a plain object;
//   - flat indexed source fields, up to MAX_SOURCES:
//       sources[0].sourceId, sources[0].url, sources[0].observedAt,
//       sources[0].documentDate, sources[0].note, sources[1].… ;
//     a plain object may instead carry `sources` as an array of objects;
//   - `value` for reraNumbers: an array, repeated `value` entries in FormData,
//     or one string separated by newlines/commas;
//   - status "unknown" ⇒ value must be empty/null; ≥1 source is still required,
//     describing where we looked.
//   Blank strings are treated as absent.
import { z } from "zod";
import type { ConstructionStatus, ResearchFactField, SourceRef } from "@/domain/types";
import { validateRegistrationReference } from "./evidence";

export const MAX_SOURCES = 3;
export const RESEARCH_FACT_FIELDS = ["address", "reraNumbers", "constructionStatus", "declaredPossession"] as const satisfies readonly ResearchFactField[];
export const CONSTRUCTION_STATUSES = [
  "pre_launch",
  "under_construction",
  "ready_to_move",
  "completed",
  "stalled",
  "unknown",
] as const satisfies readonly ConstructionStatus[];

/** Allowed clock skew when checking observedAt is not in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const isoDate = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s) && !Number.isNaN(Date.parse(s)), "must be an ISO date");

export const FactSourceSchema = z
  .object({
    sourceId: z.string().trim().min(1, "sourceId required"),
    url: z
      .string()
      .trim()
      .refine((s) => {
        try {
          return new URL(s).protocol === "https:";
        } catch {
          return false;
        }
      }, "url must be a valid https URL"),
    observedAt: z.string().trim().datetime({ offset: true, message: "observedAt must be an ISO timestamp" }),
    documentDate: isoDate.optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const observed = Date.parse(s.observedAt);
    if (observed > Date.now() + FUTURE_SKEW_MS) {
      ctx.addIssue({ code: "custom", path: ["observedAt"], message: "observedAt is in the future" });
    }
    if (s.documentDate !== undefined && Date.parse(s.documentDate) > observed) {
      ctx.addIssue({ code: "custom", path: ["documentDate"], message: "documentDate is after observedAt" });
    }
  });

const reraRef = z
  .string()
  .trim()
  .superRefine((s, ctx) => {
    const r = validateRegistrationReference(s);
    if (!r.ok) ctx.addIssue({ code: "custom", message: `registration reference ${r.reason}` });
  })
  .transform((s) => s.trim().replace(/\s+/g, " "));

const common = {
  projectId: z.string().trim().min(1, "projectId required"),
  status: z.enum(["known", "unknown"]),
  sources: z.array(FactSourceSchema).min(1, "at least one source is required").max(MAX_SOURCES),
};

const variants = [
  z.object({ ...common, field: z.literal("address"), value: z.string().trim().min(5).max(300).nullable() }).strict(),
  z
    .object({
      ...common,
      field: z.literal("reraNumbers"),
      value: z
        .array(reraRef)
        .min(1)
        .max(5)
        .refine((a) => new Set(a).size === a.length, "duplicate registration reference")
        .nullable(),
    })
    .strict(),
  z.object({ ...common, field: z.literal("constructionStatus"), value: z.enum(CONSTRUCTION_STATUSES).nullable() }).strict(),
  z.object({ ...common, field: z.literal("declaredPossession"), value: z.string().trim().min(1).max(100).nullable() }).strict(),
] as const;

export const FactEditSchema = z.discriminatedUnion("field", variants).superRefine((e, ctx) => {
  if (e.status === "known" && e.value === null) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "value required when status is known" });
  }
  if (e.status === "unknown" && e.value !== null) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "value must be empty when status is unknown" });
  }
});

export type FactEdit = z.infer<typeof FactEditSchema>;
export type FactEditResult = { ok: true; value: FactEdit } | { ok: false; errors: string[] };

type FlatEntry = [string, unknown];

function entriesOf(raw: unknown): FlatEntry[] | null {
  if (raw && typeof raw === "object") {
    const maybe = raw as { entries?: unknown };
    if (typeof maybe.entries === "function" && !Array.isArray(raw)) {
      return Array.from((raw as { entries(): Iterable<FlatEntry> }).entries());
    }
    return Object.entries(raw as Record<string, unknown>);
  }
  return null;
}

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const SOURCE_KEY = /^sources\[(\d+)\]\.(sourceId|url|observedAt|documentDate|note)$/;

/** Normalise flat FormData-like input into the FactEditSchema input shape. */
export function normalizeFactEditInput(raw: unknown): Record<string, unknown> | null {
  const entries = entriesOf(raw);
  if (!entries) return null;
  const out: Record<string, unknown> = {};
  const values: unknown[] = [];
  const indexed: Record<number, Record<string, unknown>> = {};
  let extraIndexedSource = false;

  for (const [key, v] of entries) {
    const m = SOURCE_KEY.exec(key);
    if (m) {
      const i = Number(m[1]);
      if (i >= MAX_SOURCES) {
        extraIndexedSource = true;
        continue;
      }
      const val = blankToUndef(v);
      if (val !== undefined) (indexed[i] ??= {})[m[2]] = val;
    } else if (key === "value") {
      values.push(v);
    } else {
      out[key] = v;
    }
  }

  // value: repeated entries -> array; single entry -> as is; blank -> null
  let value: unknown = values.length > 1 ? values : values[0];
  if (Array.isArray(value)) value = value.map(blankToUndef).filter((x) => x !== undefined);
  else value = blankToUndef(value);
  if (out.field === "reraNumbers" && typeof value === "string") {
    value = value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(value) && value.length === 0) value = undefined;
  out.value = value === undefined ? null : value;

  if (extraIndexedSource) {
    out.sources = Array.from({ length: MAX_SOURCES + 1 }, () => ({})); // surfaces the max-sources error
  } else if (Object.keys(indexed).length > 0) {
    out.sources = Object.keys(indexed)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => indexed[i]);
  } else if (out.sources === undefined) {
    out.sources = [];
  }
  return out;
}

export function parseFactEdit(raw: unknown): FactEditResult {
  const input = normalizeFactEditInput(raw);
  if (!input) return { ok: false, errors: ["(root): expected an object or form data"] };
  if (Array.isArray(input.sources) && input.sources.length > MAX_SOURCES) {
    return { ok: false, errors: [`sources: at most ${MAX_SOURCES} sources`] };
  }
  const r = FactEditSchema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** Convert validated sources to domain SourceRefs. */
export function toSourceRefs(edit: FactEdit): SourceRef[] {
  return edit.sources.map((s) => ({
    sourceId: s.sourceId,
    url: s.url,
    observedAt: s.observedAt,
    documentDate: s.documentDate ?? null,
    ...(s.note ? { note: s.note } : {}),
  }));
}
