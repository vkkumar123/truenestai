# Spec 03 — Source registry and scheduled crawl (Loop 1)

**Needs from Fury:** Reddit API app (client id/secret), YouTube Data API key,
Google Places API key (Maps Platform), optional SerpApi/Outscraper key for
review volume, GCS bucket, Cloud Scheduler permissions.

## Goal
A single scheduled job that walks the `sources` table, fetches anything past
its cadence, lands the raw payload, and hands new/changed content to the
extraction agent (spec 04). Adding a source type = adding one adapter file.

## Behaviour
1. Cloud Scheduler hits Cloud Run Job `crawl` every 30 min.
2. Job selects `sources where enabled and (last_fetched_at is null or
   last_fetched_at < now() - cadence_hours)` ordered by staleness, limit 300.
3. For each row, call `adapters/<adapter>.fetch(source_row) -> Payload`.
4. Compute `content_hash`. If equal to `last_content_hash` → update
   `last_fetched_at`, skip extraction (constitution §9).
5. Else write raw to GCS `gs://nb-re-raw/<adapter>/<scope_id>/<ts>.json` and
   BigQuery `nb_re_raw.<adapter>_payloads`, then enqueue
   `extraction_queue(payload_uri, source_id)`.
6. Record `last_status` (`ok`, `blocked`, `404`, `error:<msg>`); after 3
   consecutive errors set `enabled=false` and log for ops.

## Adapter contract
```python
class Payload(TypedDict):
    source_id: int
    scope_type: str; scope_id: str
    adapter: str
    url: str
    fetched_at: datetime
    content_type: str          # 'html','json','text'
    content: str
    meta: dict                 # adapter-specific (e.g. review count, post ids)

def fetch(source: SourceRow) -> Payload: ...
def discover(scope: ScopeRow) -> list[SourceRow]: ...   # optional: find new URLs for a scope
```

## Adapters for v1 (build in this order)

| adapter | scope | cadence | ttl | notes |
|---|---|---|---|---|
| `rera_karnataka` | project | 7d | 14d | K-RERA project search by number; capture status, dates, extensions, complaints, promoter |
| `builder_site` | project | 7d | 14d | project page + price/brochure page; respect robots.txt |
| `news_rss` | locality, development | 1d | 7d | Google News RSS query per locality/development name + "Bengaluru" |
| `govt_notice` | development | 1d | 7d | BMRCL, BDA, KRDCL, NHAI, KIADB, BBMP press/notice pages |
| `reddit` | project, locality | 1d | 30d | r/bangalore, r/indianrealestate, r/bengaluru search; official API |
| `youtube` | project | 1d | 30d | Data API search → video ids → comments; walkthrough videos |
| `google_places` | project | 3d | 30d | Places API details → 5 reviews, rating, count; swap to SerpApi/Outscraper if more needed |
| `portal_price` | project | 7d | 10d | Housing/99acres/MagicBricks listing psf ranges only; 1 req/5s, rotate UA; price signal only |

`discover()` for `reddit`, `youtube`, `news_rss` runs weekly per scope and
inserts new `sources` rows for threads/videos/articles worth tracking.

## Fetch etiquette
- Real User-Agent with contact email; `robots.txt` honoured for all HTML adapters.
- Per-domain concurrency 1, min delay 2s (5s for portals).
- Exponential backoff on 429/503; never retry a 403 more than once per day.

## Seeding the registry
Script `seed_sources.py`: for every project in `projects`, insert rows for
`rera_karnataka`, `builder_site`, `google_places`, `portal_price`, and a
`reddit`/`youtube`/`news_rss` discover scope. For every locality insert
`news_rss` and `reddit`. For every development insert `govt_notice` + `news_rss`.

## Done when
A full pass over 10 seeded projects lands payloads for every adapter, a second
pass skips unchanged content, and a deliberately changed builder page gets
re-extracted. Logs show per-adapter success/blocked counts.
