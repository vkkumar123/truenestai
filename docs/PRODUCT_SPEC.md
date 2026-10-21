# TrueNest AI — Product spec

Status: draft v0.1 (M0). Owner: product-architect. Contract: `src/domain/types.ts`.
Items marked **[Assumption]** need owner confirmation (see `DECISIONS.md` › Unresolved).

## 1. Vision
A **buyer-first** residential property intelligence platform for Bengaluru. Buyers see what is known about a project, where each fact came from, how fresh it is, and what is still unknown, before they share any personal data.

- **Phase 1:** North Bengaluru only. Boundary defined in `src/config/markets/` (**[Assumption]** pending owner approval).
- **Later phases:** three further Bengaluru markets (e.g. East, South, West; **[Assumption]**, exact split to be decided), added via market config, not code changes.
- **Revenue:** qualified buyer enquiries and assisted transactions. Any commercial relationship with a builder, broker or partner is **disclosed** on the affected pages. Wording: **[Assumption]**, owner/legal to approve.
- **Positioning:** evidence-led and transparent. We do **not** claim legal independence from builders, and we do not guarantee safety, title or returns.

## 2. Personas
| Persona | Need | Phase 1 support |
|---|---|---|
| **Home buyer (end user)** | Shortlist credible projects, understand risk and unknowns | Browse, details, evidence, compare, request help |
| **NRI / remote buyer** | Trustworthy info without site visits | Same, plus provenance and last-checked dates |
| **Investor buyer** | Compare stage, possession, infrastructure | Compare; no return projections |
| **Staff researcher** | Add and verify facts with sources | Admin review (M1), research tooling (M3) |
| **Staff buyer advisor** | Follow up consented requests | Admin request queue (M1) |
| **Owner / admin** | Control sources, disclosures, publishing | Source registry, roles (M2+) |

## 3. Two discovery lanes
Every result carries `lane` (`DiscoveryLane`). The UI must never blur the two.

### Lane A — Researched inventory (`Project`, `lane: "researched"`)
- Curated by staff. Every material fact is a `FactValue` with `sources[]`, `verification` and `status`.
- Shows verification state per fact, last-checked date, completeness score and review flags.
- Published only when `published: true` after human review.

### Lane B — Externally discovered (`ExternalListing`, `lane: "external"`)
- Found by an **approved** source adapter only (`DATA_SOURCE_POLICY.md`).
- Always labelled **"Unverified, discovered externally"**.
- Must show: source name, canonical URL, discovered date, last-seen date, `limitations[]`.
- Short factual title only; no copied descriptions or images.
- Primary action: **Request verification**, which creates a lead of type `verification`.
- Linked to a Lane A project only via strong-identifier dedupe (`matchedProjectId`). Similar names are never enough.

## 4. Trust rules (enforced in copy, UI and data)
1. **Unknown ≠ negative.** `status: "unknown"` renders as "Not yet found / not verified", never as a red flag or a "no".
2. **RERA ≠ title.** A RERA registration shows that a registration exists. It is not title clearance, approval of quality, or a legal opinion. Title items go to `requires_professional_review`.
3. **No guarantees** of safety, title, possession dates or returns. Declared possession is shown as "declared by developer/RERA" with source.
4. **No claim of legal independence** from builders. Commercial relationships are disclosed.
5. **Provenance on every fact:** source, URL (if any), observed date, verification state.
6. **Samples are labelled.** `isSample` records show a visible "Sample data" badge. Phase 1 fixtures are fictional.
7. **Infrastructure** is shown with its stage (`proposed` … `operational`) and source. Declared completion is never a promise.
8. **No fabricated data.** No invented prices, builders, RERA numbers or URLs.

## 5. First slice: user journeys (M1, fixture data)

### J1 Browse projects
- Landing → list of North Bengaluru results, filterable by locality (from market config), configuration (BHK), construction status and lane.
- Each card: name, developer, locality, lane badge, verification summary, last-checked date, sample badge.
- No sign-in and no personal data are needed.

### J2 View project details and evidence (Lane A)
- Sections: overview, unit configurations (price/area as `FactValue`), regulatory records, documents, infrastructure nearby, review flags, unknowns.
- Each fact has an evidence affordance listing its sources (source, URL, observed date, verification).
- Standard disclaimer block: RERA ≠ title, no guarantees, commercial disclosure (if any).

### J3 Compare up to 4
- Add from cards or detail pages. The limit of 4 is enforced with a clear message.
- Side-by-side facts with verification state; unknown cells are neutral, not negative.
- Lane B items may be compared but stay labelled unverified, with limited fields.
- Compare state needs no account (URL or local state).

### J4 Lane A vs Lane B
- Results list shows both lanes with distinct badges and an explainer ("What does unverified mean?").
- Lane B detail: source, canonical URL (outbound link), discovered/last-seen dates, limitations, **Request verification**.

### J5 Request verification / buyer assistance
- Entry points: Lane B detail (verification), Lane A detail and compare (buyer assistance).
- Form maps to `LeadInput`: name, email or phone, preferred channel, optional message/budget band.

### J6 Consent-aware lead capture
- Browsing collects no personal data. Attribution (UTM, landing path) is held client-side and sent only with a submitted lead.
- `contactConsent` is required to store a lead. `marketingConsent` is optional, separate and unticked by default.
- Consent text is versioned (`consentTextVersion`). Each lead gets a `retentionUntil`.
- Confirmation screen states what happens next and how to withdraw.
- Legal basis and wording under DPDP Act: **[Assumption]**, needs legal review. See `SECURITY_PRIVACY.md`.

### J7 Staff review in protected admin
- `/admin` requires staff auth: fixture mode uses a dev-only credential (disabled in production); Supabase Auth with staff roles from M2.
- Request queue: list and filter by type/status; view a lead; change status (`new → contacted → qualified → closed`, or `withdrawn`).
- Lane B items flagged for verification are visible with their source data.
- Admin pages are never indexed or cached publicly.

### Acceptance (summary; full list in `ROADMAP.md` M1)
Journeys J1–J7 work end to end on fixtures, covered by unit and e2e tests; trust rules are visible in UI copy.

## 6. Non-goals (for now)
- Markets outside North Bengaluru; rentals, commercial or plots (**[Assumption]**: residential apartments/villas only).
- Buyer accounts, saved searches, notifications.
- Live scraping or any unapproved source; any automated RERA access before permission.
- Legal opinions, title verification, valuations, price predictions or return projections.
- Payments, bookings, escrow, or any money movement.
- Automated outbound marketing (email/SMS/WhatsApp sends) or paid ad spend.
- Builder self-serve portal and paid listings.
- Native mobile apps.
