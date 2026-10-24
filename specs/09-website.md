# Spec 09 — Public website

**Needs from Fury:** domain, hosting (Vercel/Cloud Run), WhatsApp Business
number + provider (Interakt/AiSensy/Gupshup) for click-to-chat links, founder
name/photo/one-paragraph bio, privacy policy sign-off.

## Positioning (copy must reflect this)
"The honest research tool for North Bangalore apartments. Builders pay us a
channel-partner fee if you buy through us — you pay nothing, and we tell you
when not to buy."

## Pages
1. **Home** — search box (locality / project / budget), 3 featured
   comparisons, the promise block ("we never sell or share your number"),
   founder block with real name and face, "how we make money" in one paragraph.
2. **Project page** `/projects/{project_id}` — statically generated; the SEO engine.
   Sections, in order:
   - Header: name, builder, locality, RERA number, status tier, last-verified date
   - **Legal & RERA**: status, registration date, completion date (promised vs
     current, with revision history), extension count, complaints, OC, khata,
     land title note — each with source link. Conflicts shown side by side.
   - **True cost**: cost sheet per unit type (spec 07) with status badge and
     basis; "Get the real cost sheet on WhatsApp" CTA.
   - **Area brief** (spec 08) with a small map: project pin + nearby
     developments coloured by status tier.
   - **What residents & buyers say**: signal summary with themes, counts,
     dates, links. Never verbatim reviews.
   - **Compare**: "add to compare" (max 3).
   - **Verdict**: 2–3 sentences, generated only from the facts on the page,
     reviewed by Fury before publish (flag `verdict_approved`).
   - Every CTA → WhatsApp click-to-chat with prefilled text carrying
     `project_id` and page section, e.g. "Hi, I'm looking at {name} — can you
     send the real cost sheet? [ref:{project_id}:cost]".
3. **Locality guide** `/localities/{slug}` — locality brief, psf trend chart,
   launched/coming lists, water/flooding/traffic notes, all projects in the area.
4. **Compare** `/compare?ids=a,b,c` — side-by-side on RERA risk, true cost,
   possession, proximity, sentiment. Shareable URL. "Send this to my WhatsApp" CTA.
5. **Shortlist tool** `/find` — budget, config, must-have localities,
   timeline → ranked list with reasons, shown on screen **unlocked**; capture
   is "Send to WhatsApp / alert me on changes".
6. **Red-flag posts / comparisons** `/insights/...` — editorial, Fury-approved.
7. **About / How we make money / Privacy (DPDP)**.

## Capture points (every one = exchange for value)
| hook | where | prefilled WhatsApp ref |
|---|---|---|
| Get the real cost sheet | project page cost block | `{project}:cost` |
| Compare 3 for my budget | /find results | `shortlist:{ids}` |
| Alert me on price / tower launch | project page | `{project}:alert` |
| Book a no-pitch site visit | project page bottom | `{project}:visit` |
| Ask anything about this project | sticky bottom bar (mobile) | `{project}:ask` |
Optional form fallback (name, phone, consent checkbox) writes to `leads`
with consent fields (constitution §7). No form submits without consent.

## Tech
- Next.js App Router, static generation from Supabase at build + ISR
  (revalidate 6 h, on-demand revalidate webhook from the crawler when a
  project's facts change).
- Mobile-first; LCP < 2.5 s on 4G; images lazy; no third-party ad scripts.
- Schema.org `Residence` / `Place` + FAQ markup per project page.
- Sitemap per locality; canonical URLs; OG images generated per project
  with name, locality, status tier, last-verified date.
- Analytics: privacy-friendly (Plausible/Umami), event per capture click
  with `ref`.

## SEO content plan (driven by data, not copywriting)
Titles follow buyer search intent: "{name} {locality} — RERA status, real
cost, possession date (verified {month year})". Locality guides target
"2BHK in {locality} under ₹{X}", "{locality} vs {locality}".

## Done when
80 project pages build from seed data, Lighthouse mobile ≥ 90, every capture
click opens WhatsApp with the correct ref, an estimate renders with the badge
and an official sheet renders without it, and a page with a missing required
fact triggers a `page_build` research task instead of rendering blank.
