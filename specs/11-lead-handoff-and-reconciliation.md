# Spec 11 — Partner handoff and payout reconciliation

**Needs from Fury:** partner's name, WhatsApp number and/or email, their CP
code(s) per builder, the signed 50/50 agreement reference, agreed payout
timing (e.g. within 15 days of builder paying brokerage).

## Goal
Every lead that leaves our system is traceable to a booking and a payout.
Our revenue depends on the partner tagging leads under their CP code before
the visit and reporting bookings truthfully; the system makes both easy and
makes gaps visible.

## Handoff
On `handoff(lead_id)`:
1. Generate `handoff_brief` (spec 10) and set `handed_off_at`.
2. Send to partner via WhatsApp template + email with the brief and a link to
   the partner dashboard row.
3. Create `partner_tasks(lead_id, task='cp_tag', due = visit_time - 2h)` and
   `partner_tasks(lead_id, task='visit_feedback', due = visit_time + 6h)`.
4. Remind partner via template if a task is overdue; escalate to Fury after 2 reminders.

## Partner dashboard (Supabase auth, roles: owner=Fury, partner)
Columns per lead: `lead_id, handed_off_at, project(s), visit slot, CP-tagged
(Y/N + proof upload), visited (Y/N + notes), booking (Y/N, value, date,
unit), brokerage expected (value × builder CP % — table per builder),
our 50% share, builder payout received (date, amount), our payout received
(date, amount), status`.
Partner can edit: CP-tag proof, visit notes, booking fields, payout received.
Owner sees everything; every edit is audit-logged.

## Reconciliation job (monthly, 1st of month)
- List every lead with `stage ∈ {visit_scheduled, visited}` and no booking
  update in 30 days → partner reminder.
- Every `booked` lead → expected brokerage and our share; compare with
  payouts received; produce `reconciliation_report` (PDF/Sheet) emailed to
  both parties.
- Flag: leads marked `lost` within 7 days of a visit without notes;
  bookings reported > 45 days after the visit; brokerage % below the
  builder table.

## Brokerage table
`builder_cp_terms(builder_id, cp_percent, payout_trigger, payout_days,
source, last_verified)` — maintained by partner, verified by Fury.

## Our ground presence
Operational, not code: our person attends the first visit of every
qualified lead, confirms the CP tag with the builder's sales desk on the
spot, and logs it in the dashboard. This is the single biggest protection
against leakage.

## Done when
A handed-off test lead shows in the partner dashboard, an overdue CP-tag
task triggers a reminder, a booking entry computes the expected share, and
the monthly job produces a report with one flagged anomaly.
