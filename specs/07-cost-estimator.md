# Spec 07 — Cost sheet estimator (official / estimated / unknown)

**Needs from Fury:** nothing new. Uses spec 05 for search. Fury or the
partner uploads official sheets via an admin form (Part D).

## Goal
Every project page and every WhatsApp cost question shows an all-in cost
sheet per unit type with one of three statuses. Until the builder/partner
gives us the official sheet, we compute a labelled **estimate** from public
price signals plus the Karnataka add-on table. Never present an estimate as
official (constitution §2).

## Part A — Base price discovery (status → estimated)
Run as a `research_tasks` job with `trigger='gap'|'stale'` on
`attribute='base_psf'` (TTL 10 days) or on demand.
Source authority order and what to extract:
1. Builder site price page / brochure → `base_psf` range, `status='official'`
   if explicitly stated (rare; builders say "price on request").
2. Partner-shared quote (Part D) → official.
3. Portal listings (Housing/99acres/MagicBricks/NoBroker) → psf range from
   ≥ 3 listings of the same project, last 60 days → estimated, conf 0.6.
4. Reddit / forum "I was quoted ₹X psf" threads, dated ≤ 6 months → estimated,
   conf 0.5; store as `signals` too.
5. News on launch pricing → estimated, conf 0.55, decays 0.05/month.
Take the inter-quartile range of all signals with conf ≥ 0.5 as
`base_psf_low/high`. Fewer than 2 signals → `status='unknown'`.

## Part B — Karnataka add-on table (`assumptions_v1`, version it)
Values below are starting defaults; ops verifies annually and whenever a
budget/GST change lands. Store as a versioned JSON so every estimate records
which table it used.

| line item | default | basis |
|---|---|---|
| Base price | `base_psf × sba_sqft` | Part A |
| Floor rise | ₹25–50 / sqft per floor above 3rd | builder norm; use project fact if present |
| PLC (corner / park / lake facing) | ₹50–150 / sqft, optional | builder norm |
| GST | 5% of (base + floor rise + PLC + car park + clubhouse) for under-construction, no ITC; 1% affordable; **0% if OC received** | GST rules — verify |
| Car park | ₹3,00,000 – ₹5,00,000 covered | market norm |
| Clubhouse / amenities | ₹1,50,000 – ₹3,00,000 | market norm |
| Maintenance advance | ₹3–5 / sqft / month × 12–24 months | builder norm |
| Corpus / sinking fund | ₹50–100 / sqft | builder norm |
| BESCOM / BWSSB / infra charges | ₹1,00,000 – ₹2,00,000 | builder norm |
| Khata / legal / documentation | ₹25,000 – ₹75,000 | norm |
| Stamp duty | 5% of agreement value (> ₹45L) | Karnataka Stamp Act — verify slab |
| Surcharge + cess on stamp duty | +2% and +10% of stamp duty (effective ≈ 5.6%) | verify |
| Registration | 1% of agreement value | verify |
| Home-loan processing | 0.25–0.5% of loan (optional line) | lender norm |
| Pre-EMI / interest during construction | shown separately if loan-funded and under construction | computed from timeline fact |

Agreement value for stamp duty = base + floor rise + PLC (exclude car park/
clubhouse only if the builder's sheet does — default include; note assumption).

## Part C — Output
Insert `cost_sheets` row per `(project_id, unit_type)`:
- `line_items`: each with `amount_low, amount_high, basis` ("portal psf IQR
  ×1,250 sqft", "assumptions_v1.gst").
- `total_low/high`, `as_of`, `status`, `basis` = `{sources:[...],
  assumptions_version:'v1', signal_count:n}`.
- `ttl_hours` 240 for estimated, 720 for official.

Render rule (site + WhatsApp):
> **Estimated all-in: ₹1.42–1.58 Cr** for 3BHK ~1,450 sqft
> *Estimate as of 23 Oct 2026 from 5 public price signals — not the builder's
> official sheet. Want the actual cost sheet? Ask on WhatsApp →*
That last line is the primary capture hook (spec 09).
Official sheets render with "Official cost sheet · dated {as_of} · via our
channel partner".

## Part D — Official sheet intake
Admin form (Supabase auth, Fury + partner only): upload PDF/image → spec 04
extraction with `source_type='builder'`, `status='official'`, `high_value`
flag → replaces estimate in `facts_current` precedence; old estimate stays in
`facts_history`. The page then shows "Official sheet replaced our estimate;
estimate was ₹X–Y" for 30 days (trust signal: we show our own error).

## Done when
A seeded project with no price facts produces an `estimated` sheet from ≥ 2
signals, a project with < 2 signals produces `unknown`, uploading a sample
official sheet flips status to `official`, and every rendered sheet shows
status + date + basis.
