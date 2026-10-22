# Supabase setup (owner steps)

This switches TrueNest AI from fixture data to a real Supabase project (`DATA_BACKEND=supabase`).
Everything below is done by the **owner** in the Supabase dashboard and on a trusted machine.
Never paste keys or the database password into chat, issues, commits or logs. `.env*` files are gitignored;
only `.env.example` (no values) is committed.

Dashboard labels change from time to time; if a menu item has moved, search the dashboard for the
setting named here.

## 1. Create the project
1. Create a new project (region close to Bengaluru, e.g. Mumbai `ap-south-1`). Save the database password in
   your password manager — it is shown once.
2. Use separate projects for **staging** (may hold SAMPLE data) and **production** (reference data only).

## 2. Collect keys and connection details
| Variable | Where in the dashboard | Secret? |
|---|---|---|
| `SUPABASE_URL` | Project Settings → Data API (or API) → Project URL, `https://<ref>.supabase.co` | no |
| `SUPABASE_ANON_KEY` | Project Settings → API Keys → **publishable** key (`sb_publishable_…`), or the legacy `anon` key | low (RLS-limited), still server-only here |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → **secret** key (`sb_secret_…`), or the legacy `service_role` key | **yes — bypasses RLS** |
| `SUPABASE_DB_URL` | Connect (top bar) → Connection string → *Session pooler* (port 5432) or *Direct connection*; insert the DB password | **yes** |

Put them in `.env.local` (development) or the hosting provider's secret store (staging/production), together with:
```
DATA_BACKEND=supabase
SESSION_SECRET=<48 random bytes, base64url>   # still required by env validation
TRUSTED_PROXY_HOPS=<1, or 2 behind a Google external LB>
```
`ADMIN_DEV_PASSWORD` is not used in Supabase mode and the dev login is refused in production.
The service-role/secret key and `SUPABASE_DB_URL` must never get a `NEXT_PUBLIC_` prefix.

## 3. Auth settings
1. Authentication → Sign In / Providers → Email: keep **Email** enabled; turn **off "Allow new users to sign
   up"** (staff are invited by `staff:create`; there is no public sign-up).
2. Authentication → URL Configuration:
   - **Site URL**: the deployed origin, e.g. `https://<your-domain>` (staging: its own origin).
   - **Redirect URLs** (allow list): `https://<your-domain>/admin/login` and, for local work,
     `http://localhost:3000/admin/login`. Do not add wildcards for other domains.
3. Authentication → Emails: invites are sent by Supabase's built-in mailer, which is heavily rate-limited;
   configure custom SMTP before inviting more than a couple of staff.
4. Optional hardening: enable leaked-password protection and a minimum password length ≥ 12.

## 4. Data API and Storage checks
- Project Settings → Data API → **Exposed schemas**: `public` (and `graphql_public`) only. **Do not expose
  `private`** — it holds RLS helper functions and the migration ledger (0003, L9).
- Storage: the migration creates the private bucket `project-documents` (15 MB, PDF/PNG/JPEG). After
  migrating, confirm in Storage that it exists and is **not public**. Do **not** add Storage policies; the app
  reads/writes it with the service role and serves staff downloads via 60-second signed URLs.
  If the bucket is missing (the migration skips it when `storage.buckets` is absent), create it manually with
  exactly those settings.

## 5. Allowed origins / domains
- If the app runs behind a proxy/CDN whose host differs from the browser origin, add it to
  `experimental.serverActions.allowedOrigins` in `next.config.ts` (Server Action CSRF check).
- Document uploads go through the staff Route Handler `POST /api/staff/documents` (not a Server Action), so
  no Server Action body-size change is needed. If a reverse proxy/CDN caps request bodies, allow ≥ 16 MB on
  that path only.
- Optional: Database → Network restrictions to limit direct Postgres access to your IPs.

## 6. Create the schema, seed and the first admin
Run from the repository root on a trusted machine with the variables above in `.env.local`:
```bash
npm run db:migrate -- --dry-run          # lists pending migrations, changes nothing
npm run db:migrate                       # applies supabase/migrations/*.sql (ledger: private.schema_migrations)

# PRODUCTION — once, right after the first migrate, then reference data:
npm run db:migrate -- --mark-production  # writes private.settings environment = production
npm run db:seed                          # geography + source registry only (same as --seed=reference)

# STAGING / DEV only — fictional SAMPLE projects (some published):
npm run db:migrate -- --seed=full --allow-sample

npm run staff:create -- --email owner@<your-domain> --role admin --name "Owner" --dry-run
npm run staff:create -- --email owner@<your-domain> --role admin --name "Owner"
```
- **Production marker:** `--mark-production` records `environment = production` in `private.settings`
  (migration 0004; not reachable through the Data API). On a marked database the SAMPLE seed is refused by the
  runner **and** by `seed.sql` itself (if someone pastes it into the SQL editor). Marking is refused while the
  database contains SAMPLE projects. Mark production before anything else touches the database.
- `--seed` (and `npm run db:seed`) means **reference data only**. The SAMPLE seed needs both `--seed=full`
  and `--allow-sample`, and cannot be combined with `--mark-production`.
- Migrations and seeds are idempotent; re-running is safe. An already-applied migration that was edited is
  refused — add a new migration instead.
- This runner keeps its own ledger. Do not also apply the same migrations with the Supabase CLI
  (`supabase db push`) on that database.
- `staff:create` sends a Supabase invite email to new users (they set their own password); for existing users it
  only sets the role. Re-run with `--role advisor` / `--role admin` to change a role.
- SAMPLE projects are fictional (`is_sample = true`, names start with "SAMPLE", `example.com` URLs) and come with
  the fictional fixture sources; `reference.sql` contains no fixture sources.

## 7. Verify
1. `DATA_BACKEND=supabase npm run dev`, open `/` — staging shows the published SAMPLE projects (production: none).
2. Accept the invite email, set a password, sign in at `/admin/login`.
3. In `/admin/leads` submit a test lead from the public form (staging) and check that an advisor only sees it
   after an admin assigns it.
4. Upload a small PDF on a project's admin page and download it again (you should be redirected to a
   `…/storage/v1/object/sign/project-documents/…` URL that expires after 60 seconds).
5. Leave the admin page open for more than an hour and reload: you should stay signed in (session refresh in
   `src/proxy.ts`).

## npm scripts (in package.json)
```json
"db:migrate": "tsx --env-file-if-exists=.env.local --conditions=react-server scripts/db-migrate.ts",
"db:seed": "tsx --env-file-if-exists=.env.local --conditions=react-server scripts/db-migrate.ts --seed",
"db:seed:generate": "tsx --conditions=react-server scripts/generate-seed.ts",
"staff:create": "tsx --env-file-if-exists=.env.local --conditions=react-server scripts/create-staff.ts"
```
`db:seed` loads reference data only. `--conditions=react-server` makes the `server-only` guard resolve to its no-op build outside Next.js.
