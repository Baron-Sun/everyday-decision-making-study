# Real PostgreSQL concurrency checks

These tests create disposable **local-only** PostgreSQL databases named `aita_load_*`. They never contact Supabase, use real participant identifiers, or change Prolific. The runner refuses non-loopback database hosts. Each burst opens a distinct TCP connection per operation, verifies distinct `pg_backend_pid()` values, confirms the anonymous role's actual `statement_timeout=3s`, then sends the SQL statements together. This is not the JavaScript allocation simulation used by the unit suite.

## Run locally

Install the optional test runtime outside the repository; it is not an application dependency:

```sh
npm install --prefix /private/tmp/aita-pg-runtime embedded-postgres@17.9.0-beta.17 pg@8.16.3
export PG_DRIVER_PATH=/private/tmp/aita-pg-runtime/node_modules/pg/lib/index.js
export EMBEDDED_POSTGRES_PATH=/private/tmp/aita-pg-runtime/node_modules/embedded-postgres/dist/index.js
node tests/concurrency/start-local-postgres.mjs
```

Run subsequent commands in another terminal from the repository. The launcher binds only `127.0.0.1:55439`, creates a temporary cluster with 650 connection slots, and removes that cluster when stopped. PostgreSQL's shared memory and localhost networking may require sandbox approval on macOS. An existing local PostgreSQL server also works with `LOCAL_PG_URL` and equivalent roles/connection settings.

```sh
export PG_DRIVER_PATH=/private/tmp/aita-pg-runtime/node_modules/pg/lib/index.js
export LOCAL_PG_URL=postgresql://postgres:local-benchmark-only@127.0.0.1:55439/postgres
export BASELINE_SETUP_SQL=/private/tmp/aita-pg-runtime/baseline_setup.sql
git show 7c4ce6f4056a347b1ba21c5f13070321bd405dc3:supabase_advice_transfer_setup.sql > "$BASELINE_SETUP_SQL"

node tests/concurrency/validate-migrations.mjs
node tests/concurrency/run.mjs --label=current --arrivals=100,200,500
```

`run.mjs` defaults to the live `claim_advice_transfer_assignment_same_post` wrapper and opinion-difficulty phase-2 payload. `--wrapper=v4` additionally exercises historical A-to-B/effort sessions. Select an isolated baseline or upgrade chain with `--setup=/absolute/file.sql` and `--migrations=file1.sql,file2.sql`; `--output=/absolute/report.json` saves results. Pass `--events=false` when testing a historical server that intentionally lacks the new comprehension-event deduplication feature. Database names are recreated on each run, so run the same label serially.

For the actual historical deployed source, apply these migrations in order after the baseline setup and seed:

```text
supabase_advice_transfer_v4_gist_migration.sql
supabase_advice_transfer_same_post_migration.sql
supabase_advice_transfer_opinion_difficulty_migration.sql
supabase_advice_transfer_leading_label_only_patch.sql
```

Append `supabase_advice_transfer_concurrency_upgrade_checked.sql` twice to test the checked upgrade and its idempotence under load. `validate-migrations.mjs` already exercises this history, the full upgrade, fresh setup, preservation of permissions/settings, known body hashes, and atomic rejection of unknown installed source.

## Coverage and interpretation

- 100, 200, and 500 simultaneous formal arrivals against exactly 20 cells × 5 quota tokens.
- 100 heartbeats + 100 drafts + 200 extra arrivals in one 400-connection burst.
- 100 phase-1 saves, 100 phase-2 saves, and 100 finals + 100 duplicate final retries + 100 heartbeats.
- 50 simultaneous claims from the same Prolific participant with different session IDs.
- Reviving an expired participant as standby before admitting a newcomer; replacing 20 expired quota reservations during 200 new arrivals.
- 30 identical comprehension-event retries count as one wrong answer.
- A deliberately locked participant row while 40 unrelated operations run, revealing cross-participant head-of-line blocking.
- Real historical locked snapshots created by the historical stage-save function survive an upgrade and submit/retry unchanged. Incomplete or wrong new audit metadata remains rejected. No immutability trigger is disabled.

Busy admission responses and `55P03` lock timeouts are retried with 500–2000 ms jitter, up to a 30-second test budget. Reports retain busy/retry counts, first-attempt p95, and total participant wait. A waiting response after all 100 quota reservations are occupied is expected capacity handling, not a successful assignment or an error. Quota invariants also inspect token ownership and duplicate participants. Historical baselines intentionally return a nonzero exit code where the regression cases fail.

The tests use a local PostgreSQL 17.9 server, not Supabase Nano hardware or its PostgREST/pooler/TLS/browser/network stack. They validate real SQL contention, retry recovery and quota correctness, but do not establish a production capacity limit or guarantee zero returned submissions. Connection setup is completed before each SQL burst; its latency is not included in the reported request timings.

Results from 2026-09-05 are in `results/`. The final same-post baseline and upgraded reports are the primary comparison; earlier A-to-B reports are retained separately as supplementary checks. The expected behavior under contention is a short retry instead of holding every participant behind a slow row. This can increase end-to-end wait on a fast local host, even while substantially reducing the first response time and avoiding unrelated 3-second timeouts.
