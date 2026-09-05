# Online Research Study App

This is a static React frontend for separate crowdsourcing tasks.
It can be deployed to GitHub Pages.

The participant-facing title is intentionally neutral so the study does not
prime participants with the primary research question before debriefing.

The root page is a researcher-facing portal. Participant-facing task links are
separate pages.

## Task Pages

- `/advice/`: one-shot advice exposure task
- `/judgment/`: single-post response task
- `/ratings/`: multi-post rating task
- `/comment-source/`: two-post, same-source comment-likelihood task
- `/advice-transfer/`: Study 2 online-opinion task

Use separate crowdsourcing studies or separate study links for these pages.

## Comment-source pretest

The formal comment-source task uses 10 primary posts crossed with two
between-participant comment-source conditions. Each participant is assigned
once to Human or AI, then sees two different posts whose five-comment sets both
come from that assigned source. Supabase creates 50 two-post participant slots
per condition, for 100 valid participants and 200 item ratings in total. Every
post receives exactly 10 ratings per condition. Three reserve posts remain
inactive. Test IDs beginning with `test-`, `preview-`, or `qa-` are balanced
separately and never consume a formal slot.

The participant flow is overview → informed consent → instructions and
attention check → two sequential post ratings → completion. The two post and
comment orders are fixed for that participant across refreshes. Incorrect
attention-check answers are persisted in Supabase. The first failure allows one
retry; the second marks the assignment `screened_out`, permanently ends that
participant session, and reopens the exact formal quota slot. Copy, cut, paste, drag/drop,
and the context menu are disabled throughout the participant page.

All 130 stored exposure comments are normalized to plain ASCII: emoji,
decorative Unicode punctuation, and Markdown formatting symbols are removed,
while ordinary English punctuation and wording are retained. Regenerate the
stimulus JSON and seed with the prototype's `scripts/build_stimuli.py` before
applying the seed to Supabase.

Run `supabase_source_detection_formal.sql` after the original 13-post
source-detection schema and seed, then run
`supabase_source_detection_dual.sql`. The first migration restricts formal
allocation to the 10 primary posts and installs the persisted two-strike
attention check. The second creates 100 same-source, two-post participant slots
and replaces the assignment, submission, review, and progress routines. An
excluded, abandoned, or twice-screened participant reopens the exact two-post
slot for replacement recruitment.

For Prolific External Study Link:

```text
https://baron-sun.github.io/online-research-study/comment-source/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}&completion_code=YOUR_PROLIFIC_CODE
```

For a test session, use a unique test ID and optionally add `debug=1`:

```text
https://baron-sun.github.io/online-research-study/comment-source/?PROLIFIC_PID=test-review-001&STUDY_ID=source-pretest&SESSION_ID=review-001&debug=1
```

## Study 2 advice-transfer task

The formal Study 2 task crosses 10 active Reddit posts with two masked
comment-source conditions. A participant reads one post and five Human or five
AI comments, classifies each comment's expressed judgment, summarizes their
gist, and rates the difficulty of producing that summary. The participant then
returns to the same post and writes a final opinion, with their locked summary
and the same five comments visible for reference. The three reserve stimuli
remain inactive. The original B posts are retained only as historical stimulus
metadata and are not displayed in the same-post design.

### V4 gist protocol (test release, 28 August 2026)

The participant-facing and future Prolific public title is **Study About Online
Opinions**. This release implements the approved feedback in
[New test web app](https://docs.google.com/document/d/1APA6y4UeF6fuxf6puTN89CuRT14kzaNXft3jfGQrciQ/edit).
It preserves the selected stimuli, source conditions, random comment order,
and quota/standby assignment policy. Because the comments remain visible while
participants respond to the same post, this protocol measures direct comment
influence and must not be described as cross-dilemma transfer or as excluding
direct reference or imitation. No stimulus reselection is part of this update.

Flow: overview → consent → Phase 1 instructions and two-attempt comprehension
question → Phase 2 instructions → post/comment classifications/gist/gist difficulty
→ same-post opinion with the locked gist and comments → confidence and final-opinion difficulty → the existing
three-step funnel → five core demographic questions → saved confirmation and
debrief.

Five YTA/NTA/ESH/NAH/INFO classifications are required. They are stored as
participant responses, **not scored as right/wrong**, and do not affect the
comprehension failure count, screening, or payment decisions. Gist requires at
least 25 English words. `gistDifficulty` is a separate measure. New same-post
assignments use the existing `difficulty` field for final-opinion difficulty
and set `post_task_measure = 'opinion_difficulty'`; historical v4 assignments
retain the original effort item and are marked `post_task_measure = 'effort'`.
The two measures are never silently pooled.

For displayed comments, only an explicit AITA judgment abbreviation at the
very beginning is removed. Any YTA/NTA/ESH/NAH/INFO appearing later in the
comment remains exactly where it was, so the comment's substantive wording is
not rewritten. Raw stimulus text is never modified. Existing sessions resume
with the exact displayed text and hashes they originally received.

`claim_advice_transfer_assignment_v4` uses the same allocator/advisory lock as
the original six-argument claim RPC. New assignments are stamped
`advice-transfer-v4-gist`; existing assignments retain their original protocol
and use the preserved legacy frontend, including unfinished drafts and final
submission retries. Local v4 backups use a separate storage namespace.

`save_advice_transfer_stage` atomically records immutable `phase1` and `phase2`
snapshots. Phase 1 locks before the response page is shown; Phase 2 (opinion plus
confidence and the assignment-specific post-task measure) locks before
purpose/source guesses. Back remains available for
read-only review. Retry returns the original stored snapshot and lock time,
even if its first acknowledgement was lost. Drafts, departure saves, and final
submissions cannot overwrite committed answers. Pending stage/final requests
remain in the local backup while autosave continues.

Timing definitions: `phase1ActiveTimeMs` accumulates while the editable post page
is visible. `gistActiveTimeMs` is the subset during which focus is inside the
gist text/rating panel; it is **not** a measure of unobserved thinking before
focus. `adviceResponseTimeMs` accumulates only on the editable same-post response page. Hidden
tabs, other pages, and read-only visits after a lock do not add to these
durations. First-entry/edit timestamps and server lock times are also retained.
The total session duration includes time outside the task pages.

For an existing database, apply `supabase_advice_transfer_v4_gist_migration.sql`
before publishing the frontend. It does not seed/reset data or change
recruitment/targets. Heartbeat and departure now acquire the existing shared
advisory lock before row locks, consistent with claim/submit, avoiding a
previous lock-order inversion without changing allocation policy.

After the v4 migration, apply `supabase_advice_transfer_same_post_migration.sql`.
It preserves existing A-to-B assignments and submissions. Only newly created
assignments use `design_variant = 'same_post'`. The original pair metadata is
retained, while `response_post_id` and `response_post_body_sha256` identify the
post that was actually shown for the participant's Phase 2 response.

Then apply `supabase_advice_transfer_opinion_difficulty_migration.sql`, followed
by `supabase_advice_transfer_leading_label_only_patch.sql`. The final patch
changes only newly claimed comment presentations; assignments already in
progress continue with their originally stored comment hashes and text.

`tests/advice-transfer-v4-integration.sql` tests validation, immutable stages,
stale drafts, legacy compatibility and idempotency using QA IDs inside a
rollback-only transaction. The legacy lifecycle test remains separate.

This is a **test release, not authorization to open recruitment**. Keep formal
recruitment closed and retain the provisional 10–12 minute estimate. The five
core demographic questions were copied from the first page of Felix's
Qualtrics `Demos` block and appear after the funnel: gender identity, age,
English-language status, education, and employment. The later political and
social-media batteries in that block are intentionally not treated as
demographics. Confirm duration, consent, compensation and the Prolific
completion code before formal launch.

The open-ended response requires at least 77 English words. This threshold is
the rounded mean of the 3,846 words across the 50 Human exposure comments in
the 10 active primary A stimuli (76.92 words per comment); the same English-word
regular expression is used for the stimulus audit, browser validation, and
database validation. Reserve-pair comments are not included in this benchmark.

Run `supabase_advice_transfer_setup.sql`, then
`supabase_advice_transfer_seed.sql`. The setup is safe to rerun on the preview
database: it preserves assignments and submissions while upgrading the formal
allocator, renewable leases, draft autosave, idempotent submission, review
status, and progress view.

Formal recruitment is closed by default. Set the number of usable responses
required in each of the 20 pair-by-condition cells before opening recruitment.
For example, a balanced target of 100 usable responses means 5 per cell:

```sql
update public.advice_transfer_settings
   set setting_value = '5'::jsonb, updated_at = now()
 where setting_key = 'formal_target_per_cell';

update public.advice_transfer_settings
   set setting_value = 'true'::jsonb, updated_at = now()
 where setting_key = 'formal_recruitment_open';
```

To close new allocation without interrupting already assigned participants,
set `formal_recruitment_open` back to `false`. Monitor cell completion and
active leases with:

```sql
select * from public.advice_transfer_formal_cell_progress;
```

The formal allocator uses hard, reusable quota tokens. At the balanced target
above, each of the 20 pair-by-condition cells has exactly five tokens. A token
can be `available`, `reserved` by one active participant, `pending` after a
complete response, or `valid` after review. Consequently, the number of
quota-bearing responses in a cell can never exceed its target, even when many
participants open the link simultaneously.

If all tokens are temporarily reserved, a new participant sees a short waiting
screen that polls automatically; it never receives a database error or needs to
refresh. Closing the tab shortens the reservation to a 90-second grace period,
and a 30-second heartbeat renews active sessions. If a participant is still
waiting after 90 seconds, they can begin as a masked standby. Standby responses
are retained and paid, but do not enter the primary quota unless a token in the
same cell becomes available. This prevents a late old browser and its
replacement from both counting toward the designed sample.

Unfinished responses are saved both locally and in Supabase, and an interrupted
final submission retries automatically on reopening. Withdrawn, expired,
twice-screened, or excluded observations release their token; the oldest
eligible standby in that same cell is promoted automatically. Review status and
token state are both visible in `advice_transfer_formal_cell_progress`. The
study is complete only when every row has `valid = target_per_cell` and
`quota_invariant_ok = true`.

Before launch, run `tests/advice-transfer-integration.sql` in the seeded
Supabase project while formal recruitment is closed and no formal records
exist. It exercises waiting, expiry, replacement, late submission, exclusion,
same-cell promotion, and the final token invariant inside a transaction that
rolls every test mutation back.

Use this Prolific External Study Link:

```text
https://baron-sun.github.io/online-research-study/advice-transfer/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}&completion_code=YOUR_PROLIFIC_CODE
```

For launch, use single submission and set Prolific concurrent submissions to
10–15 rather than Unlimited. Set the initial maximum submissions to the planned
total (for example 100), start with a 10-person paid soft launch, and check the
progress view before releasing the rest. If review exclusions leave deficits,
add only the number shown by the sum of `remaining`; the reopened tokens ensure
replacements go to the correct cells. The target may be increased safely, but
must not be lowered after tokens have been created.

## Study 2 concurrency upgrade (5 September 2026)

Apply `supabase_advice_transfer_concurrency_migration.sql` before deploying the
new frontend. For the verified existing live database,
`supabase_advice_transfer_concurrency_upgrade_checked.sql` performs the same
upgrade with exact before/after function-body checks. It accepts both the
committed setup and the known live migration variants and aborts atomically on
an unknown version. Both scripts are safe to rerun. Existing historical locked
snapshots remain immutable and can still be submitted after the upgrade.

Independent participants now share a coordination gate for heartbeat, drafts,
phase snapshots, and departure, while assignment rows serialize each person's
own changes. Quota ownership changes retain an exclusive transaction gate and
unique quota tokens. All public participant functions bound lock waits to
250 ms; transient congestion is retried with jitter without raising the global
anonymous statement timeout. Admission no longer waits behind an inactive
queue head; existing eligible standby work retains priority for its own cell.

The frontend serializes requests for one assignment, coalesces queued autosaves,
prioritizes stage/final saves, and persists comprehension event IDs so a lost
acknowledgement cannot count the same wrong answer twice. Temporary closed
entry polls automatically; **formal recruitment must still be opened explicitly
when the study is actually launched**.

`supabase_advice_transfer_prepare_100.sql` prepares the authorized sample of
20 cells x 5 responses while retaining closed recruitment. It refuses unexpected
existing targets or formal participant records. The quota cap limits primary
responses, not the number of people who may wait or produce paid standby work.
More than 100 completed responses must never all be counted as primary quota.

Real PostgreSQL load/lifecycle tests and recorded local results are documented
in `tests/concurrency/README.md`. These use independent database connections and
3-second anonymous statement timeouts. Local results validate behavior under
the tested load and failure scenarios; they are not a measured capacity limit
for the live Supabase Nano machine or its HTTP connection pool.

## Local Development

```bash
npm install
npm run dev
```

## GitHub Pages Deployment

1. Create a new GitHub repository. A clean repository is strongly recommended.
2. Push this app folder to the repository's `main` branch.
3. In GitHub, open `Settings > Pages`.
4. Set `Source` to `GitHub Actions`.
5. Push to `main`; the included workflow will build and deploy the app.

For a user/organization Pages site, name the repository `<username>.github.io`.
For a project Pages site, any repository name is fine; Vite will set the base path
automatically in GitHub Actions.

With GitHub CLI, after `gh auth login`, one typical path is:

```bash
gh repo create online-research-study --public --source=. --remote=origin --push
```

For an existing repository:

```bash
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

## Runtime Query Parameters

The app can run in demo mode, but real data collection should use a backend for
assignment and response storage. For `/ratings/` and `/advice/`, the current
recommended backend is Supabase. For `/judgment/`, the older
`assignment_url`/`submit_url` mode is still supported.

```text
https://example.github.io/repo/?assignment_url=https%3A%2F%2Fapi.example.org%2Fassignment%2Fabc&submit_url=https%3A%2F%2Fapi.example.org%2Fsubmit&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

The app also accepts:

- `api_base`: backend base URL with `/assignment`
- `assignment_id`
- `posts_url`: URL returning either an array of posts or an assignment object
- `n_posts`: number of posts to show; default is 5
- `completion_code`
- `contact_email`

## Ratings Assignment JSON

For `/ratings/`, `assignment_url` should return:

```json
{
  "assignmentId": "worker-batch-001",
  "completionCode": "COMPLETE123",
  "contactEmail": "william.brady@kellogg.northwestern.edu",
  "posts": [
    {
      "id": "submission_id",
      "title": "Post title",
      "body": "Post text",
      "sourceBin": "low|medium|high"
    }
  ]
}
```

The app randomizes post order deterministically using assignment and participant
metadata, then submits one JSON payload containing one rating object per post.

## Judgment Assignment JSON

For `/judgment/`, `assignment_url` should return:

```json
{
  "assignmentId": "judgment-worker-001",
  "completionCode": "COMPLETE123",
  "contactEmail": "william.brady@kellogg.northwestern.edu",
  "post": {
    "id": "submission_id",
    "title": "Post title",
    "content": "Post text"
  },
  "previousResponse": {
    "id": "previous_response_id",
    "text": "Optional prior response text"
  }
}
```

## Important Backend Note

GitHub Pages is static hosting. It can display the experiment, but it cannot
store responses or allocate the next study assignment by itself.
For real data collection, connect `submit_url` and `assignment_url` to a backend
such as Supabase, Firebase, Google Apps Script, Qualtrics, or a small API server.

If `submit_url` is omitted, responses are saved only in the participant's browser
local storage. That mode is useful for demos, not for live crowdsourcing.

## Supabase Backend For `/ratings/`

The ratings task can use Supabase directly through the browser. No extra npm
package is required.

1. Create a Supabase project.
2. Open `SQL Editor` and run `supabase_setup.sql`.
3. Generate the full153k v1 import files with
   `python3 scripts/prepare_full153k_imports.py`.
4. In Supabase Table Editor, import
   `supabase_import/full153k_v1/rating_posts_import_full153k_v1.csv` into the
   `rating_posts` table.
5. Import
   `supabase_import/full153k_v1/rating_assignment_slots_import_full153k_v1.csv`
   into the `rating_assignment_slots` table. This file contains 180 fixed
   five-post assignments: each of the 300 posts appears exactly 3 times, each
   topic appears 90 times, each controversy bucket appears 300 times, and each
   topic x controversy cell appears 30 times.
6. In GitHub, open this repository's `Settings > Secrets and variables >
   Actions > Variables` and add:

```text
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
VITE_RATING_COMPLETION_CODE=RATING2026
VITE_RESEARCH_CONTACT_EMAIL=william.brady@kellogg.northwestern.edu
```

7. Re-run the GitHub Pages workflow or push to `main`.

For local testing, copy `.env.example` to `.env.local` and fill in the same
values, then run:

```bash
npm run dev
```

Open the ratings task with a test Prolific ID:

```text
http://localhost:5173/ratings/?PROLIFIC_PID=test-worker-001&STUDY_ID=test-study&SESSION_ID=test-session
```

For Prolific External Study Link, use:

```text
https://baron-sun.github.io/online-research-study/ratings/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

If the Prolific completion code is not set with
`VITE_RATING_COMPLETION_CODE`, append it to the study URL:

```text
https://baron-sun.github.io/online-research-study/ratings/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}&completion_code=YOUR_PROLIFIC_CODE
```

After a successful Supabase save, the final page sends participants to
`https://app.prolific.com/submissions/complete?cc=YOUR_PROLIFIC_CODE`.

The Supabase RPC assigns the next open row from `rating_assignment_slots`,
reuses the same assignment if the participant refreshes, and saves the final
payload to `rating_submissions`. The frontend never samples rating posts; the
fixed database slot determines the five posts.
Comprehension-check failures are also stored on `rating_assignments`: after two
incorrect choices, the assignment is marked `screened_out`, and reopening the
same Prolific link will show the study-ended screen with no completion code.

For the current controversiality-rating task, each post has three required
ratings: OP wrongness, personal ambivalence, and perceived disagreement. The
final page asks two soft post-task questions instead of a color attention check.
On Prolific, mark the study as sensitive content, set the expected time to 10
minutes, and pilot with about 10 participants before full launch.

## Supabase Backend For `/advice/`

The advice exposure task uses separate `advice_*` tables and RPCs, so it does
not change or depend on the ratings task tables.

1. Open `SQL Editor` and run `supabase_advice_setup.sql`.
2. Generate the full153k v1 import files with
   `python3 scripts/prepare_full153k_imports.py`.
3. Import one-shot exposure stimuli into `advice_stimuli`. Each row should
   include one exposure dilemma, one related second dilemma, human comments,
   and LLM comments. For the full153k v1 launch files, human-condition slots
   show 5 comments and LLM-condition slots show 3 comments.
4. Import balanced assignable rows into `advice_slots`, with one row per
   participant slot and `condition` set to either `human_comments` or
   `llm_comments`.
5. Add `VITE_ADVICE_COMPLETION_CODE=C164ME01` as a GitHub Actions variable if
   you want to override the default completion code, then redeploy.

For local testing:

```text
http://localhost:5173/advice/?PROLIFIC_PID=test-worker-001&STUDY_ID=test-study&SESSION_ID=test-session
```

For Prolific External Study Link:

```text
https://baron-sun.github.io/online-research-study/advice/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

If the Prolific completion code is not set with
`VITE_ADVICE_COMPLETION_CODE`, append it to the study URL:

```text
https://baron-sun.github.io/online-research-study/advice/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}&completion_code=YOUR_PROLIFIC_CODE
```

After a successful Supabase save, the final page sends participants to
`https://app.prolific.com/submissions/complete?cc=YOUR_PROLIFIC_CODE`.

The RPC assigns one stimulus/feed per participant, reuses the same assignment
after refresh, stores two-strike comprehension screenouts, and saves final
responses to `advice_submissions`.
