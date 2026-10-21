// Consent copy shown next to the lead form. DRAFT — pending legal review (DPDP Act 2023).
// Any change to the wording below MUST bump CONSENT_TEXT_VERSION so stored leads record
// exactly which text the person agreed to.

export const CONSENT_TEXT_VERSION = "2026-10-21.v1";

export const CONSENT_COPY_STATUS = "draft_pending_legal_review" as const;

export const CONSENT_COPY = {
  version: CONSENT_TEXT_VERSION,
  status: CONSENT_COPY_STATUS,
  /** Required checkbox. A lead is stored only when this is ticked. */
  contactConsent:
    "I agree that TrueNest may contact me about this request using my chosen contact channel. " +
    "TrueNest will use my details only to respond to this request.",
  /** Optional, separate checkbox. Never pre-ticked; not required to submit. */
  marketingConsent:
    "Optional: I would also like to receive occasional updates from TrueNest about properties and market information. " +
    "I can withdraw this at any time.",
  /** Shown near the submit button. */
  commercialDisclosure:
    "TrueNest may receive fees from developers or partners when a transaction happens. " +
    "We disclose these relationships to you. This information is not legal advice, and TrueNest " +
    "does not guarantee title, safety or returns of any property.",
  withdrawal:
    "You can ask us to stop contacting you or delete your request at any time.",
} as const;
