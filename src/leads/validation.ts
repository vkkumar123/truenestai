import { z } from "zod";
import type { ContactChannel, LeadInput } from "@/domain/types";
import { CONSENT_TEXT_VERSION } from "./consent";

export const BUDGET_BANDS = [
  "under_50l",
  "50l_1cr",
  "1cr_1_5cr",
  "1_5cr_2cr",
  "2cr_3cr",
  "above_3cr",
] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

export const LEAD_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  emailMax: 254,
  messageMax: 1000,
  idMax: 100,
  attributionMax: 100,
  landingPathMax: 300,
} as const;

/** Normalises an Indian mobile number to "+91XXXXXXXXXX", or returns null if invalid. */
export function normaliseIndianMobile(input: string): string | null {
  let digits = input.trim().replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) {
    if (!digits.startsWith("+91")) return null;
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith("091")) {
    digits = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

const TRUE_STRINGS = new Set(["on", "true", "1", "yes"]);
const FALSE_STRINGS = new Set(["", "off", "false", "0", "no"]);

/** FormData checkbox → boolean. Unticked checkboxes are absent from FormData. */
const checkbox = z.preprocess((v) => {
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE_STRINGS.has(s)) return true;
    if (FALSE_STRINGS.has(s)) return false;
  }
  return v;
}, z.boolean({ error: "Please tick or untick this box." }));

/** Trimmed string; empty → null. */
const optionalText = (max: number, tooLong: string) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null) return null;
      if (typeof v === "string") {
        const t = v.trim();
        return t === "" ? null : t;
      }
      return v;
    },
    z.string({ error: "Please enter text." }).max(max, { error: tooLong }).nullable(),
  );

const optionalAttr = (max: number) =>
  optionalText(max, `Must be ${max} characters or fewer.`).transform((v) => v ?? undefined);

const flatLeadSchema = z
  .object({
    requestType: z.enum(["verification", "buyer_assistance"], {
      error: "Please choose what you need help with.",
    }),
    name: z
      .string({ error: "Please enter your name." })
      .trim()
      .min(LEAD_LIMITS.nameMin, { error: "Please enter your name (at least 2 characters)." })
      .max(LEAD_LIMITS.nameMax, { error: "Name must be 80 characters or fewer." }),
    email: optionalText(LEAD_LIMITS.emailMax, "Email address is too long.").pipe(
      z.email({ error: "Please enter a valid email address." }).nullable(),
    ),
    phone: optionalText(30, "Please enter a valid 10-digit Indian mobile number.").transform(
      (v, ctx) => {
        if (v === null) return null;
        const n = normaliseIndianMobile(v);
        if (!n) {
          ctx.addIssue({ code: "custom", message: "Please enter a valid 10-digit Indian mobile number." });
          return z.NEVER;
        }
        return n;
      },
    ),
    preferredChannel: z.enum(["phone", "email", "whatsapp"], {
      error: "Please choose how we should contact you.",
    }),
    message: optionalText(LEAD_LIMITS.messageMax, "Message must be 1000 characters or fewer."),
    projectId: optionalText(LEAD_LIMITS.idMax, "Invalid project reference."),
    externalListingId: optionalText(LEAD_LIMITS.idMax, "Invalid listing reference."),
    budgetBand: optionalText(20, "Please choose a budget range from the list.").pipe(
      z.enum(BUDGET_BANDS, { error: "Please choose a budget range from the list." }).nullable(),
    ),
    contactConsent: checkbox.refine((v) => v === true, {
      error: "Please agree to be contacted so we can respond to your request.",
    }),
    marketingConsent: checkbox,
    consentTextVersion: z.literal(CONSENT_TEXT_VERSION, {
      error: "The consent text has changed. Please reload the page and try again.",
    }),
    utmSource: optionalAttr(LEAD_LIMITS.attributionMax),
    utmMedium: optionalAttr(LEAD_LIMITS.attributionMax),
    utmCampaign: optionalAttr(LEAD_LIMITS.attributionMax),
    landingPath: optionalAttr(LEAD_LIMITS.landingPathMax).refine(
      (v) => v === undefined || (v.startsWith("/") && !v.startsWith("//")),
      { error: "Invalid landing path." },
    ),
    // Honeypot: hidden from humans; bots fill it.
    website: z.preprocess(
      (v) => (v === undefined || v === null ? "" : v),
      z.string().refine((v) => v.trim() === "", { error: "Submission rejected." }),
    ),
  })
  .superRefine((d, ctx) => {
    if (d.email === null && d.phone === null) {
      ctx.addIssue({ code: "custom", path: ["phone"], message: "Please give an email address or a mobile number." });
    }
    const needs: Record<ContactChannel, "email" | "phone"> = { email: "email", phone: "phone", whatsapp: "phone" };
    const field = needs[d.preferredChannel];
    if (d[field] === null && (d.email !== null || d.phone !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["preferredChannel"],
        message:
          field === "email"
            ? "Please add an email address to be contacted by email."
            : "Please add a mobile number to be contacted by phone or WhatsApp.",
      });
    }
    if (d.projectId !== null && d.externalListingId !== null) {
      ctx.addIssue({ code: "custom", path: ["projectId"], message: "A request can refer to only one property." });
    }
  });

export const leadInputSchema = flatLeadSchema.transform((d): LeadInput => {
  const attribution: LeadInput["attribution"] = {};
  if (d.utmSource) attribution.utmSource = d.utmSource;
  if (d.utmMedium) attribution.utmMedium = d.utmMedium;
  if (d.utmCampaign) attribution.utmCampaign = d.utmCampaign;
  if (d.landingPath) attribution.landingPath = d.landingPath;
  return {
    requestType: d.requestType,
    name: d.name,
    email: d.email,
    phone: d.phone,
    preferredChannel: d.preferredChannel,
    message: d.message,
    projectId: d.projectId,
    externalListingId: d.externalListingId,
    budgetBand: d.budgetBand,
    consent: {
      contactConsent: d.contactConsent,
      marketingConsent: d.marketingConsent,
      consentTextVersion: d.consentTextVersion,
    },
    attribution,
  };
});

/** Accepts flat FormData-style objects, or nested `consent` / `attribution` objects. */
function flatten(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const { consent, attribution, ...rest } = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  for (const nested of [consent, attribution]) {
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

export type ParseLeadResult =
  | { ok: true; value: LeadInput }
  | { ok: false; errors: Record<string, string> };

export function parseLeadInput(raw: unknown): ParseLeadResult {
  const flat = flatten(raw);
  if (typeof flat !== "object" || flat === null) {
    return { ok: false, errors: { form: "Invalid submission." } };
  }
  const result = leadInputSchema.safeParse(flat);
  if (result.success) return { ok: true, value: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "form";
    if (!(key in errors)) errors[key] = issue.message;
  }
  return { ok: false, errors };
}
