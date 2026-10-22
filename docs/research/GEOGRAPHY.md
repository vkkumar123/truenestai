# Market geography — North Bengaluru (Phase 1)

Status: **boundary and all coordinates pending owner approval.** Nothing in the config has been
checked against a source yet: every locality has `completeness: 0` and `lastCheckedAt: null`.

Source of truth: `src/config/markets/data.ts` (validated by `src/config/markets/schema.ts`).
App code reads geography only through `src/config/markets/index.ts`, and never hardcodes it.

## Phases

| order | id | name | active |
|---|---|---|---|
| 1 | `north-bengaluru` | North Bengaluru | yes |
| 2 | `east-bengaluru` | East Bengaluru (placeholder) | no |
| 3 | `south-bengaluru` | South Bengaluru (placeholder) | no |
| 4 | `west-central-bengaluru` | West / Central Bengaluru (placeholder) | no |

Inactive phases have no zones or localities, and they must not be collected. The validator rejects
any locality that belongs to an inactive phase.

## North Bengaluru boundary: assumptions (pending owner approval)

The zone polygon is a coarse envelope drawn by hand (about 13.02N–13.31N, 77.48E–77.76E). It is
**not** an official BBMP, BDA or BMRDA boundary.

- **Included:** the area north of the central city along the Bellary Road / NH-44 corridor, from
  Hebbal through Jakkur and Yelahanka to Devanahalli and Kempegowda International Airport. Also
  Hennur Road, Thanisandra, Nagawara, Kalyan Nagar, Kothanur, Bagalur Road (Kannuru, Bagalur),
  Sahakara Nagar, Kodigehalli and Vidyaranyapura, and the Doddaballapur Road side (Rajanukunte,
  Doddaballapur).
- **Excluded for now (owner to decide):** RT Nagar, HRBR and Horamavu to the south; Jalahalli and
  Peenya to the north-west; Old Madras Road and KR Puram to the east.
- **Locality centroids** (31 localities) are approximate, from general knowledge, and use
  `precision: "locality_centroid"`. They need verification against an approved source before
  they are used for anything beyond coarse grouping.
- **Locality boundaries** are `null` until an approved source supplies them.
- A unit test checks that every centroid falls inside the zone polygon.

## How to change the config

1. Edit `src/config/markets/data.ts`: add or remove a locality row
   `[id, name, lat, lng, aliases]`, or change the zone polygon. Polygons use GeoJSON `[lng, lat]`
   order, and each ring must be closed.
2. Ids are kebab-case and must stay stable, because other modules reference them. These ids are
   required: `hebbal`, `yelahanka`, `devanahalli`, `thanisandra`, `hennur`, `jakkur`.
3. To activate a phase, set `active: true`, add its zone with `boundaryApproval:
   "pending_owner_approval"`, and then add its localities. Record the change in `docs/DECISIONS.md`.
4. Set `boundaryApproval: "approved"` only after the owner has signed off.
5. Update `dataCoverage` only when a source in the approved registry has really been checked.
6. Run `npx vitest run src/config src/locality`. The config is also validated at module load:
   duplicate ids, an unknown zone or phase, a malformed polygon or a wrong precision throws an
   error.

## Freshness

`src/locality/freshness.ts` classifies `lastCheckedAt` with the default thresholds:

| state | rule |
|---|---|
| `fresh` | checked 30 days ago or less |
| `aging` | 31–90 days |
| `stale` | more than 90 days |
| `never_checked` | `lastCheckedAt` is null |

The thresholds can be configured. `never_checked` means we have no data. It is not a negative
finding.

## Infrastructure stage model

`InfrastructureStage` (in `src/domain/types.ts`) has these stages: `proposed` → `approved` →
`tendered` → `under_construction` → `operational`.

| stage | minimum evidence |
|---|---|
| `proposed` | Public mention by a government body or agency (DPR, budget, plan or announcement) |
| `approved` | A sanction or approval order, or a cabinet or board decision, from the competent authority |
| `tendered` | A published tender or award notice on an official procurement portal or the agency's site |
| `under_construction` | Agency progress report or official statement that work has started |
| `operational` | Official commissioning or opening notice from the operating agency |

Evidence rules:

- Each stage claim needs at least one `SourceRef` with a URL and an `observedAt` date. Without
  one, the claim is not made, and the item stays at the last stage that has evidence.
- News coverage can support `proposed`, but it is not enough on its own for `approved` or later
  stages.
- `declaredCompletion` is filled only when an official source states a date. It is shown as
  "declared by <source> on <date>" and never as a promise.
- No statements about appreciation or price impact are made unless cited evidence supports them.
- When sources disagree, mark the item `disputed` and show both sources.
- Infrastructure items carry `lastCheckedAt` and follow the same freshness thresholds.
