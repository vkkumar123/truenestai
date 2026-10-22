# Security & Privacy

Owner: buyer-crm-engineer. Status: **draft — items marked ⚖ need legal review.** This document describes intent and engineering rules; it does not assert legal compliance.

## Roles and access

| Role | Who | Can access |
|---|---|---|
| Anonymous public | Any visitor | Published projects, external listings (labelled unverified), infrastructure, amenities. Can **insert** a lead via the server action only. Cannot read any lead. |
| Buyer | Lead submitter (no account in M1) | Submits a request. Withdrawal/deletion via a request to TrueNest (verified by contact channel) until self-service exists. |
| Advisor | Authenticated staff | Leads assigned to them: read, update status/notes. No bulk export. |
| Admin | Authenticated staff with admin role | All leads, source registry, review queue, publishing. Withdrawal/erasure actions. |
| Worker / service | Server-side jobs using the service role | Only the tables a job needs; never runs in the browser; never logs lead PII. |

## Secrets
- Secrets live in server-only env vars (e.g. `SUPABASE_SERVICE_ROLE_KEY`); documented in `.env.example` without values; `.env*` gitignored.
- Never prefix a secret with `NEXT_PUBLIC_` — those are inlined into client bundles. Only the Supabase URL and anon key may be public.
- Modules that read secrets import `server-only`.
- Rotate on suspected exposure, on staff departure, and at least yearly. Rotation is an owner action logged in `docs/MCP_REQUESTS.md`.

## Consent model (`src/leads/consent.ts`)
- Contact consent is required: no lead is stored without `contactConsent === true`.
- Marketing consent is separate, optional, never pre-ticked.
- Each lead stores `consentTextVersion` (currently `CONSENT_TEXT_VERSION`) and the persistence layer stores the consent timestamp (`createdAt`). Changing the copy means bumping the version; the server rejects stale versions.
- Copy includes the commercial-relationship disclosure, "not legal advice" and "no guarantee of title, safety or returns". ⚖ Wording is draft.

## Data minimisation
- Collected: name, email and/or phone, preferred channel, optional message (≤1000 chars), optional budget band (fixed list), optional project/listing reference, four attribution fields (`utmSource`, `utmMedium`, `utmCampaign`, `landingPath`).
- Unknown form fields are dropped by `leadInputSchema`. No IP address, device fingerprint or precise location is stored with a lead. ⚖ Confirm whether rate-limit IP data needs its own notice.

## Retention, withdrawal, deletion (`src/leads/retention.ts`)
- ⚖ Assumption: open leads (`new`/`contacted`/`qualified`) retained 12 months from creation; `closed`/`withdrawn` 24 months from creation as a minimal audit record.
- Withdrawal (`withdrawLead`): status → `withdrawn`, both consents revoked, name/contact/message/budget/attribution erased immediately. Only id, status, request type, property reference, consent version and timestamps remain.
- A scheduled job deletes rows past `retentionUntil`.
- Status changes follow `LEAD_STATUS_TRANSITIONS`; `withdrawn` is terminal.

## Logging
- Never log lead PII, request bodies, auth tokens or service-role responses. Use `redactLeadForLog(lead)` → `{ id, status, requestType }` only.
- Validation errors are logged by field name, never by value.

## Admin protection
- Admin/advisor routes require server-side session checks on every request (not only middleware/UI hiding) and role checks in RLS.
- IDOR: lead ids are random (UUID); every read/update is authorised by RLS against the caller's role/assignment, never by id alone.

## RLS expectations (owned by backend-data-engineer; tested by `npm run test:db`)
- `leads`: anon may `insert` only (through the validated server action); no `select`/`update`/`delete` for anon. Advisors `select`/`update` rows assigned to them; admins all rows. Service role bypasses RLS and is server-only.
- Public content tables: anon `select` only where `published = true`.

## DPDP Act 2023 alignment notes ⚖
High-level intent, **not a compliance claim**:
- Notice + specific consent per purpose (contact vs marketing), recorded with text version.
- Easy withdrawal, as easy as giving consent.
- Purpose and storage limitation (retention above).
- Erasure on withdrawal or purpose fulfilment.
- Grievance contact to be published. 
- Children's data: no age check today. 
- Cross-border transfer: hosting region to be confirmed.

## Incident response (basics)
1. Contain: revoke/rotate affected keys, disable the affected route.
2. Assess scope from logs (which hold no PII by design).
3. Notify the owner immediately; owner decides on notifying the Data Protection Board and affected people. ⚖ Timelines under the DPDP Rules.
4. Record the incident and fix in `docs/DECISIONS.md`; add a regression test.

## Threats and mitigations
| Threat | Mitigation |
|---|---|
| Spam / abusive lead submissions | Honeypot field `website` (must be empty); server-side rate limiting per IP + per contact detail; length limits; fixed budget enum. |
| Injection (SQL, HTML, header) | zod validation on the server; parameterised queries via Supabase client; React escaping; no user text in email headers; `landingPath` must be a relative path. |
| IDOR on admin/advisor endpoints | RLS + server-side role checks; random ids; no enumeration endpoints. |
| Secrets / PII in client bundles | No `NEXT_PUBLIC_` secrets; `server-only` imports; review build output for leaked keys before release. |
| PII in logs | `redactLeadForLog`; no request-body logging. |
| Stale consent text | Server rejects mismatched `consentTextVersion`. |
