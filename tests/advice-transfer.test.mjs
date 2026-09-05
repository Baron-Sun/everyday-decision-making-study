import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ADVICE_TRANSFER_CONSENT_TEXT } from "../src/advice-transfer-consent.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("consent preserves the original full form with only the approved duration and sample-size substitutions", () => {
  assert.match(ADVICE_TRANSFER_CONSENT_TEXT, /around 10–12 minutes/);
  assert.match(ADVICE_TRANSFER_CONSENT_TEXT, /this 10–12-minute study/);
  assert.match(ADVICE_TRANSFER_CONSENT_TEXT, /about 100 people/);
  assert.doesNotMatch(ADVICE_TRANSFER_CONSENT_TEXT, /about 600 people/);
  const original = ADVICE_TRANSFER_CONSENT_TEXT
    .replace("around 10–12 minutes", "around 8 minutes")
    .replace("this 10–12-minute study", "this 8-minute study")
    .replace("about 100 people", "about 600 people");
  // Exact UTF-8 text from f91dd45:src/App.jsx, not a rewritten/normalized copy.
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "f17e3fb9d3ec032d4966bb8532d66ffa76a4438073e24e21ceed6e8df8c207b3",
  );
});

test("registers an isolated advice-transfer route without replacing existing studies", async () => {
  const [vite, page, entry] = await Promise.all([
    read("vite.config.js"),
    read("advice-transfer/index.html"),
    read("src/advice-transfer.jsx"),
  ]);

  for (const route of [
    "advice/index.html",
    "judgment/index.html",
    "ratings/index.html",
    "comment-source/index.html",
    "advice-transfer/index.html",
  ]) {
    assert.match(vite, new RegExp(route.replace(".", "\\.")));
  }
  assert.match(page, /<title>Study About Online Opinions<\/title>/);
  assert.match(page, /\/src\/advice-transfer\.jsx/);
  assert.match(entry, /AdviceTransferTask/);
});

test("the client implements masked five-comment exposure and audited same-post responses", async () => {
  const client = await read("src/AdviceTransferTask.jsx");

  assert.match(client, /claim_advice_transfer_assignment_same_post/);
  assert.match(client, /record_advice_transfer_comprehension_failure/);
  assert.match(client, /submit_advice_transfer_payload/);
  assert.match(client, /value\.comments\.length !== 5/);
  assert.match(client, /value\.exposurePost\.postId === value\.targetPost\.postId/);
  assert.match(client, /value\.responsePost\.postId !== expectedResponsePost\.postId/);
  assert.match(client, /POST_TASK_OPINION_DIFFICULTY/);
  assert.match(client, /value\.postTaskMeasure/);
  assert.match(client, /Object\.prototype\.hasOwnProperty\.call\(value, "condition"\)/);
  assert.match(client, /Imagine you are commenting on this post in the online platform/);
  assert.doesNotMatch(client, /respond as you normally would/i);
  assert.match(client, /First, give one judgment label: YTA, NTA, ESH, NAH, or INFO/);
  assert.match(client, /Then write your opinion/);
  for (const label of ["YTA", "NTA", "ESH", "NAH", "INFO"]) {
    assert.match(client, new RegExp(`${label} —`));
  }
  assert.doesNotMatch(client, /close friend|your friend/i);
  assert.doesNotMatch(client, /adviceTransferLocked|preventBack|window\.history\.pushState/);
  for (const backLabel of [
    ">Back<",
    "Back to consent",
    "Back to instructions",
    "Back to your opinion",
    "Back to ratings",
    "Back to previous question",
  ]) {
    assert.match(client, new RegExp(backLabel));
  }
  assert.match(client, /studyStartedAt: current\.studyStartedAt \|\| time/);
  assert.match(client, /The second Reddit post/);
  assert.match(client, /Here are the comments for the previous post in case they are useful for this post/);
  assert.match(client, /Now, imagine you are commenting on the same Reddit post/);
  assert.match(client, /Your summary from Phase 1/);
  assert.match(client, /Here are the comments you read in Phase 1 in case they are useful\./);
  assert.match(client, /post=\{assignment\.responsePost\}/);
  assert.match(client, /responsePostId: assignment\.responsePost\.postId/);
  assert.match(client, /responsePostSha256: assignment\.responsePost\.sha256/);
  assert.match(client, /postTaskMeasure: assignment\.postTaskMeasure/);
  assert.ok(
    client.indexOf("Your summary from Phase 1")
      < client.indexOf("Here are the comments you read in Phase 1 in case they are useful."),
    "the locked Phase 1 gist must appear before the five comments",
  );
  assert.match(client, />Press next to begin Phase 1<\/PrimaryButton>/);
  assert.doesNotMatch(client, />Press next to begin Phase 1\.<\/PrimaryButton>/);
  assert.doesNotMatch(client, /The earlier discussion is no longer available|constructive advice/);
  assert.match(client, /LegacyAdviceTransferTask/);
  assert.doesNotMatch(client, /modelLabel|deepseek_v3|gpt_oss_120b|glm_4_6_direct/);
});

test("the same-post post-task measure uses final-opinion difficulty without rewriting legacy effort", async () => {
  const [client, protocol, migration, setup, integration] = await Promise.all([
    read("src/AdviceTransferTask.jsx"),
    read("src/advice-transfer-protocol.mjs"),
    read("supabase_advice_transfer_opinion_difficulty_migration.sql"),
    read("supabase_advice_transfer_setup.sql"),
    read("tests/advice-transfer-same-post-integration.sql"),
  ]);

  assert.match(client, /How difficult was it to form your final opinion about the dilemma\?/);
  assert.match(client, /Not at all difficult/);
  assert.match(client, /Moderately difficult/);
  assert.match(client, /Extremely difficult/);
  assert.match(client, /difficulty: isOpinionDifficultyMeasure \? opinionDifficulty : null/);
  assert.match(client, /effort: isOpinionDifficultyMeasure \? null : effort/);
  assert.ok(
    client.indexOf("How confident are you that the opinion you gave was right?")
      < client.indexOf("How difficult was it to form your final opinion about the dilemma?"),
    "confidence must be shown before final-opinion difficulty",
  );
  for (const sql of [migration, setup]) {
    assert.match(sql, /post_task_measure/);
    assert.match(sql, /opinion_difficulty/);
    assert.match(sql, /difficulty/);
    assert.match(sql, /effort/);
  }
  assert.match(protocol, /POST_TASK_OPINION_DIFFICULTY/);
  assert.match(integration, /postTaskMeasure/);
  assert.match(integration, /opinion_difficulty/);
});

test("the same-post database migration preserves old pairs and records the actual response post", async () => {
  const [migration, integration] = await Promise.all([
    read("supabase_advice_transfer_same_post_migration.sql"),
    read("tests/advice-transfer-same-post-integration.sql"),
  ]);

  assert.match(migration, /add column if not exists design_variant text not null default 'a_to_b'/);
  assert.match(migration, /add column if not exists response_post_id text/);
  assert.match(migration, /claim_advice_transfer_assignment_same_post/);
  assert.match(migration, /if v_existing_id is null[\s\S]*design_variant = 'same_post'/);
  assert.match(migration, /when v_assignment\.design_variant = 'same_post'[\s\S]*v_response -> 'exposurePost'/);
  assert.match(migration, /new\.response_post_id := new\.exposure_post_id/);
  assert.match(migration, /new\.response_post_id := new\.target_post_id/);
  assert.match(migration, /'responsePostId', new\.response_post_id/);
  assert.match(migration, /before insert or update[\s\S]*on public\.advice_transfer_submissions/);
  assert.doesNotMatch(migration, /delete from public\.advice_transfer_(assignments|submissions|stimuli)/i);
  assert.doesNotMatch(migration, /formal_recruitment_open[\s\S]*true/i);
  assert.match(integration, /designVariant' is distinct from 'same_post'/);
  assert.match(integration, /designVariant' is distinct from 'a_to_b'/);
  assert.match(
    integration,
    /response_post_id is distinct from\s+v_new_submission\.exposure_post_id/,
  );
  assert.match(integration, /^rollback;/m);
});

test("the client enforces two-strike screening, clipboard blocking, and both word minima", async () => {
  const [client, css, baseCss, consent, protocol] = await Promise.all([
    read("src/AdviceTransferTask.jsx"),
    read("src/advice-transfer.css"),
    read("src/source-detection.css"),
    read("src/advice-transfer-consent.js"),
    read("src/advice-transfer-protocol.mjs"),
  ]);

  assert.match(consent, /around 10–12 minutes/);
  assert.match(consent, /participation in this 10–12-minute study/);
  assert.match(client, /failures >= 2/);
  assert.match(client, /same participant ID cannot restart/i);
  for (const eventName of ["copy", "cut", "paste", "drop", "dragstart", "contextmenu"]) {
    assert.match(client, new RegExp(`"${eventName}"`));
  }
  assert.match(baseCss, /user-select: none/);
  assert.match(css, /user-select: text/);
  assert.match(protocol, /MIN_ADVICE_WORDS = 77/);
  assert.match(protocol, /MIN_GIST_WORDS = 25/);
  assert.match(client, /<strong>\{gistWordCount\}<\/strong> \/ \{MIN_GIST_WORDS\} words minimum/);
  assert.match(client, /wordCount < MIN_ADVICE_WORDS/);
  assert.match(client, /gistWordCount >= MIN_GIST_WORDS/);
  assert.match(protocol, /\[A-Za-z0-9\]\+\(\?:\['-\]\[A-Za-z0-9\]\+\)\*/);

  const count = (value) =>
    value.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length || 0;
  assert.equal(count(Array(76).fill("word").join(" ")), 76);
  assert.equal(count(Array(77).fill("word").join(" ")), 77);
});

test("v4 removes only the leading verdict label without rewriting the raw stimulus library", async () => {
  const [client, schema, migration, displayPatch, labelIntegration, seed] = await Promise.all([
    read("src/AdviceTransferTask.jsx"),
    read("supabase_advice_transfer_setup.sql"),
    read("supabase_advice_transfer_v4_gist_migration.sql"),
    read("supabase_advice_transfer_leading_label_only_patch.sql"),
    read("tests/advice-transfer-leading-label-integration.sql"),
    read("supabase_advice_transfer_seed.sql"),
  ]);
  assert.match(client, /judgment abbreviation at the beginning[\s\S]*has been removed/i);
  assert.match(client, /appears later in the comment remains unchanged/i);
  assert.match(client, /aria-label="Judgment label key"/);
  for (const sql of [schema, migration]) {
    assert.match(sql, /advice_transfer_remove_leading_judgment_label/);
    assert.match(sql, /advice_transfer_remove_judgment_labels/);
    assert.match(sql, /advice_transfer_remove_leading_judgment_label\(value\) as comment_text/);
    assert.match(sql, /advice_transfer_remove_judgment_labels\(value\) as legacy_text/);
    assert.match(sql, /extensions\.digest\(cleaned\.comment_text, 'sha256'\)/);
    assert.match(sql, /extensions\.digest\(cleaned\.legacy_text, 'sha256'\)/);
    assert.match(sql, /v_existing_id is null/);
    assert.match(sql, /presented_comment_sha256 = v_clean_hashes/);
    assert.match(sql, /presented_comment_sha256 = v_legacy_hashes/);
    assert.match(sql, /gist summary of at least 25 English words/i);
    assert.match(sql, /'gistWordCount', v_gist_word_count/);
  }
  assert.match(displayPatch, /advice_transfer_remove_leading_judgment_label\(value\) as comment_text/);
  assert.match(displayPatch, /advice_transfer_remove_judgment_labels\(value\) as legacy_text/);
  assert.match(displayPatch, /v_existing_id is null/);
  assert.match(displayPatch, /presented_comment_sha256 = v_clean_hashes/);
  assert.match(displayPatch, /presented_comment_sha256 = v_legacy_hashes/);
  assert.match(labelIntegration, /claim_advice_transfer_assignment_same_post/);
  assert.match(labelIntegration, /leading_label_only_integration_passed_and_rolled_back/);
  assert.match(labelIntegration, /rollback;/);
  assert.match(seed, /NTA|YTA|ESH|NAH|INFO/);
});

test("all ratings and the three-stage funnel are required and saved", async () => {
  const client = await read("src/AdviceTransferTask.jsx");

  for (const field of [
    "gistDifficulty",
    "opinionDifficulty",
    "effort",
    "confidence",
    "purposeGuess",
    "commentsStoodOut",
    "commentsStoodOutDetails",
    "aiGeneratedBelief",
    "aiLikelihood",
  ]) {
    assert.match(client, new RegExp(field));
  }
  assert.match(client, /not at all difficult/);
  assert.match(client, /very difficult/);
  assert.doesNotMatch(client, /How difficult was it to decide what advice to give/);
  assert.match(client, /Not at all effortful/);
  assert.match(client, /Extremely effortful/);
  assert.match(client, /Not at all confident/);
  assert.match(client, /Extremely confident/);
  assert.match(client, /Question 1 of 3/);
  assert.match(client, /Question 2 of 3/);
  assert.match(client, /Question 3 of 3/);
  assert.match(client, /exposureTimeMs/);
  assert.match(client, /adviceResponseTimeMs/);
  assert.match(client, /firstInputAt/);
  assert.match(client, /lastEditAt/);
});

test("the v4 flow appends the five core Qualtrics demographics before final submission", async () => {
  const [client, protocol] = await Promise.all([
    read("src/AdviceTransferTask.jsx"),
    read("src/advice-transfer-protocol.mjs"),
  ]);

  for (const text of [
    "To complete the task, please answer a few questions about yourself.",
    "With which gender identity do you mostly identify?",
    "What is your age?",
    "Is English your first language?",
    "Please indicate your education level",
    "Are you currently...?",
    "Prefer not to say",
    "No, but fluent",
    "More than eighth grade, but less than high school degree",
    "Graduate or professional training",
  ]) {
    assert.match(client, new RegExp(text.replace(/[?.]/g, "\\$&")));
  }
  assert.match(client, /setScreen\("demographics"\)/);
  assert.match(client, /demographics: normalizeDemographics\(demographics\)/);
  assert.match(protocol, /DRAFTABLE_SCREENS[\s\S]*"demographics"/);
  assert.match(protocol, /age >= 18 && age <= 120/);
  assert.match(protocol, /demographicsComplete/);
});

test("the Study 2 client survives traffic bursts and interrupted final saves", async () => {
  const [client, css, timing, network] = await Promise.all([
    read("src/AdviceTransferTask.jsx"),
    read("src/advice-transfer.css"),
    read("src/useAdviceTransferTiming.js"),
    read("src/advice-transfer-network.mjs"),
  ]);

  assert.match(client, /heartbeat_advice_transfer_assignment/);
  assert.match(client, /save_advice_transfer_draft/);
  assert.match(client, /withdraw_advice_transfer_assignment/);
  assert.match(client, /mark_advice_transfer_departure/);
  assert.match(client, /admissionStatus === "waiting"/);
  assert.match(client, /Current queue position/);
  assert.match(client, /HEARTBEAT_INTERVAL_MS = 30_000/);
  assert.match(network, /keepalive: true/);
  assert.match(network, /AbortController/);
  assert.match(network, /data === null/);
  assert.match(client, /result\.saved === false/);
  assert.match(client, /result\.active === false/);
  assert.match(client, /p_draft_payload: departureDraft/);
  assert.match(client, /event\?\.persisted/);
  assert.match(client, /Complete study on Prolific/);
  assert.match(client, /sessionId \|\| "session" : "formal"/);
  assert.match(client, /CLAIM_RETRY_DELAYS_MS/);
  assert.match(client, /SUBMIT_RETRY_DELAYS_MS/);
  assert.match(client, /pendingSubmission/);
  assert.match(client, /recoverSessionRef\.current = recoverSession/);
  assert.match(client, /recoverSessionRef\.current\(\)/);
  assert.match(client, /pendingStageRef\.current\) \{ saveStage\(pendingStageRef\.current\); return; \}\s*if \(phase1LockedAt\)/);
  assert.match(client, /pendingStageRef\.current\) \{ saveStage\(pendingStageRef\.current\); return; \}\s*if \(phase2LockedAt\)/);
  assert.match(client, /Review debrief/);
  assert.match(client, /Retry submission/);
  assert.match(client, /window\.localStorage/);
  assert.match(client, /freshDraft[\s\S]*timing\.read\(\)/);
  assert.doesNotMatch(client, /timing\.pulse/);
  assert.doesNotMatch(timing, /setPulse|\bpulse\b|setInterval/);
  assert.match(css, /transfer-save-status/);
  assert.match(client, /const updateAdvice = \(event\) => \{[\s\S]*?setSaveState\("idle"\);[\s\S]*?setAdvice\(value\);/);
  assert.match(client, /<SaveStatus state=\{saveState === "offline" \|\| advice\.trim\(\) \? saveState : "idle"\} \/>/);
  assert.match(client, /if \(saveState !== "saved"\) return undefined;[\s\S]*?setTimeout\(\(\) => setSaveState\("idle"\), 2_000\)/);
  assert.match(client, /setStageSaveState\("idle"\);\s*setSaveState\("idle"\);/);
});

test("the formal database enforces hard per-cell quota tokens and standby promotion", async () => {
  const schema = await read("supabase_advice_transfer_setup.sql");

  assert.match(schema, /formal_target_per_cell/);
  assert.match(schema, /assignment_lease_minutes/);
  assert.match(schema, /reclaim_expired_advice_transfer_assignments/);
  assert.match(schema, /lease_expires_at/);
  assert.match(schema, /validity_status in \('pending', 'valid'\)/);
  assert.match(schema, /heartbeat_advice_transfer_assignment/);
  assert.match(schema, /save_advice_transfer_draft/);
  assert.match(schema, /review_advice_transfer_assignment/);
  assert.match(schema, /advice_transfer_formal_cell_progress/);
  assert.match(schema, /create table if not exists public\.advice_transfer_quota_tokens/);
  assert.match(schema, /create table if not exists public\.advice_transfer_waitlist/);
  assert.match(schema, /state in \('available', 'reserved', 'pending', 'valid'\)/);
  assert.match(schema, /promote_advice_transfer_standby/);
  assert.match(schema, /quota_invariant_ok/);
  assert.match(schema, /advice_transfer_admission_v3/);
  assert.match(schema, /unique \(prolific_pid, study_id\)/);
  assert.match(schema, /where not is_test/);
  assert.match(schema, /guard_advice_transfer_target_reduction/);
  assert.match(schema, /advice_transfer_assignment_quota_token_unique/);
  assert.match(schema, /drop view if exists public\.advice_transfer_formal_cell_progress/);
  assert.match(schema, /queued\.study_id = coalesce\(p_study_id, ''\)/);
  assert.match(schema, /The selected Study 2 quota token was no longer available/);
  assert.match(schema, /advice_word_count >= 77/);
  assert.match(schema, /v_word_count < 77/);
});

test("the rollback-only database acceptance script covers the full replacement lifecycle", async () => {
  const integration = await read("tests/advice-transfer-integration.sql");
  assert.match(integration, /^begin;/m);
  assert.match(integration, /admissionStatus' <> 'waiting'/);
  assert.match(integration, /reclaim_expired_advice_transfer_assignments/);
  assert.match(integration, /late old browser should initially be standby/);
  assert.match(integration, /review_advice_transfer_assignment[\s\S]*'excluded'/);
  assert.match(integration, /quota_committed > target_per_cell/);
  assert.match(integration, /^rollback;/m);
  assert.match(integration, /integration_passed_and_rolled_back/);
});

const buildQuotaSimulation = (target = 5) => {
  const cells = Array.from({ length: 20 }, (_, index) => ({
    index,
    tokens: Array.from({ length: target }, () => ({ state: "available", owner: null })),
    standby: [],
  }));
  const participants = new Map();

  const invariant = () => {
    for (const cell of cells) {
      assert.equal(cell.tokens.length, target);
      assert.ok(cell.tokens.every(({ state }) => ["available", "reserved", "pending", "valid"].includes(state)));
      assert.ok(cell.tokens.filter(({ state }) => state !== "available").length <= target);
      assert.equal(new Set(cell.tokens.filter(({ owner }) => owner).map(({ owner }) => owner)).size,
        cell.tokens.filter(({ owner }) => owner).length);
    }
  };

  const claim = (participantId) => {
    if (participants.has(participantId)) return participants.get(participantId);
    const eligible = cells.filter((cell) => cell.tokens.some(({ state }) => state === "available"));
    if (!eligible.length) {
      const cell = cells.slice().sort((a, b) => a.standby.length - b.standby.length || a.index - b.index)[0];
      const record = { participantId, cell: cell.index, kind: "waiting", status: "waiting" };
      participants.set(participantId, record);
      return record;
    }
    const cell = eligible.slice().sort((a, b) =>
      a.tokens.filter(({ state }) => state !== "available").length -
        b.tokens.filter(({ state }) => state !== "available").length || a.index - b.index)[0];
    const token = cell.tokens.find(({ state }) => state === "available");
    token.state = "reserved";
    token.owner = participantId;
    const record = { participantId, cell: cell.index, kind: "quota", status: "claimed" };
    participants.set(participantId, record);
    invariant();
    return record;
  };

  const toStandby = (participantId) => {
    const record = participants.get(participantId);
    assert.equal(record.kind, "waiting");
    record.kind = "standby";
    record.status = "claimed";
    cells[record.cell].standby.push(participantId);
    return record;
  };

  const release = (participantId) => {
    const record = participants.get(participantId);
    const cell = cells[record.cell];
    const token = cell.tokens.find(({ owner }) => owner === participantId);
    if (token?.state === "reserved") {
      token.state = "available";
      token.owner = null;
    }
    record.status = "abandoned";
    const nextId = cell.standby.find((id) => participants.get(id).status === "claimed");
    if (nextId) {
      const next = participants.get(nextId);
      token.state = "reserved";
      token.owner = nextId;
      next.kind = "quota";
    }
    invariant();
  };

  const submit = (participantId) => {
    const record = participants.get(participantId);
    const cell = cells[record.cell];
    const token = cell.tokens.find(({ owner }) => owner === participantId);
    record.status = "submitted";
    record.countsTowardQuota = Boolean(token && record.kind === "quota");
    if (record.countsTowardQuota) token.state = "pending";
    invariant();
  };

  return { cells, participants, claim, toStandby, release, submit, invariant };
};

test("a 100-person burst reserves exactly five observations in every formal cell", () => {
  const simulation = buildQuotaSimulation();
  for (let index = 0; index < 100; index += 1) simulation.claim(`P${index}`);
  simulation.invariant();
  assert.ok(simulation.cells.every((cell) => cell.tokens.every(({ state }) => state === "reserved")));
  assert.equal(simulation.claim("P0"), simulation.participants.get("P0"));
  assert.equal(simulation.participants.size, 100, "the same Prolific ID cannot receive a second assignment");
});

test("extra arrivals wait, replacements inherit released tokens, and late tabs never double count", () => {
  const simulation = buildQuotaSimulation();
  for (let index = 0; index < 100; index += 1) simulation.claim(`P${index}`);
  for (let index = 100; index < 110; index += 1) simulation.toStandby(simulation.claim(`P${index}`).participantId);

  const returning = Array.from({ length: 10 }, (_, index) => `P${index}`);
  returning.forEach((participantId) => simulation.release(participantId));
  simulation.invariant();

  const promoted = [...simulation.participants.values()].filter(
    ({ kind, participantId }) => kind === "quota" && /^P10\d$/.test(participantId),
  );
  assert.equal(promoted.length, 10);
  promoted.forEach(({ participantId }) => simulation.submit(participantId));

  returning.forEach((participantId) => simulation.submit(participantId));
  assert.ok(returning.every((participantId) => !simulation.participants.get(participantId).countsTowardQuota));
  assert.equal(simulation.cells.reduce((sum, cell) =>
    sum + cell.tokens.filter(({ state }) => state !== "available").length, 0), 100);
});
