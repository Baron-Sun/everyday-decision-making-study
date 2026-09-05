import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  createStudyTransport, admissionWait, jitterDelay,
  newComprehensionEvent, restoreComprehensionEvent,
} from "../src/advice-transfer-network.mjs";

const config = { url: "https://study.invalid", anonKey: "test-only" };
const payload = (revision = 0, assignment = "A") => ({ p_assignment_id: assignment, p_payload: { revision } });
const response = (body = { ok: true }, status = 200, retryAfter = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => retryAfter }, text: async () => JSON.stringify(body),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("same-assignment drafts coalesce to latest while stage saves take priority without overlapping requests", async () => {
  const gate = deferred();
  const calls = [];
  let active = 0;
  let peak = 0;
  const transport = createStudyTransport({
    fetchImpl: async (url, options) => {
      active += 1; peak = Math.max(peak, active);
      const body = JSON.parse(options.body);
      calls.push([url.split("/").at(-1), body.p_payload.revision]);
      if (calls.length === 1) await gate.promise;
      active -= 1;
      return response({ ok: true, revision: body.p_payload.revision });
    },
  });
  const first = transport.request(config, "save_advice_transfer_draft", payload(1));
  const stale = transport.request(config, "save_advice_transfer_draft", payload(2));
  const latest = transport.request(config, "save_advice_transfer_draft", payload(3));
  const stage = transport.request(config, "save_advice_transfer_stage", payload(4));
  const heartbeat = transport.request(config, "heartbeat_advice_transfer_assignment", payload(5));
  gate.resolve();
  const results = await Promise.all([first, stale, latest, stage, heartbeat]);
  assert.equal(peak, 1);
  assert.deepEqual(calls, [
    ["save_advice_transfer_draft", 1], ["save_advice_transfer_stage", 4],
    ["save_advice_transfer_draft", 3], ["heartbeat_advice_transfer_assignment", 5],
  ]);
  assert.equal(results[1].revision, 3);
  assert.equal(results[2].revision, 3);
});

test("independent assignments can run concurrently and failed lanes remain usable", async () => {
  const gate = deferred();
  const calls = [];
  const transport = createStudyTransport({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.p_assignment_id);
    if (body.p_assignment_id === "A") await gate.promise;
    return body.p_payload.revision === 0 ? response({ message: "invalid" }, 400) : response();
  } });
  const failed = transport.request(config, "save_advice_transfer_stage", payload(0)).catch((e) => e);
  await transport.request(config, "save_advice_transfer_stage", payload(1, "B"));
  assert.deepEqual(calls, ["A", "B"]);
  gate.resolve();
  assert.equal((await failed).retryable, false);
  assert.deepEqual(await transport.request(config, "save_advice_transfer_stage", payload(2)), { ok: true });
});

test("lock congestion, rate limits, network interruption and incomplete replies retry with jitter; validation errors stop", async () => {
  for (const first of [
    response({ code: "55P03", message: "lock busy" }, 400),
    response({ message: "rate limited" }, 429, "2"),
    new Error("offline"),
    response(null),
  ]) {
    let calls = 0;
    const sleeps = [];
    const transport = createStudyTransport({ random: () => 0,
      sleep: async (delay) => sleeps.push(delay),
      fetchImpl: async () => {
        if (calls++ > 0) return response();
        if (first instanceof Error) throw first;
        return first;
      },
    });
    assert.deepEqual(await transport.request(config, "save_advice_transfer_stage", payload(), [0, 1_000]), { ok: true });
    assert.equal(calls, 2);
    assert.equal(sleeps[0], first.status === 429 ? 2_000 : 750);
  }
  let calls = 0;
  const transport = createStudyTransport({ fetchImpl: async () => {
    calls += 1; return response({ code: "22023", message: "invalid response" }, 400);
  } });
  await assert.rejects(transport.request(config, "save_advice_transfer_stage", payload()), { message: "invalid response", retryable: false });
  assert.equal(calls, 1);
});

test("response-body timeout aborts and retries rather than hanging after headers", async () => {
  let calls = 0;
  const transport = createStudyTransport({ timeoutMs: 10, sleep: async () => {},
    fetchImpl: async (_url, options) => {
      if (calls++ > 0) return response();
      return { ...response(), text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
      }) };
    },
  });
  assert.deepEqual(await transport.request(config, "save_advice_transfer_stage", payload(), [0, 1]), { ok: true });
  assert.equal(calls, 2);
});

test("a waiting final submission supersedes retries of a failing background draft", async () => {
  const gate = deferred();
  const calls = [];
  const transport = createStudyTransport({ sleep: async () => {}, fetchImpl: async (url) => {
    const method = url.split("/").at(-1); calls.push(method);
    if (method === "save_advice_transfer_draft") { await gate.promise; return response({ code: "55P03" }, 400); }
    return response({ ok: true, status: "submitted" });
  } });
  const draft = transport.request(config, "save_advice_transfer_draft", payload()).catch((error) => error);
  const final = transport.request(config, "submit_advice_transfer_payload", payload(2));
  gate.resolve();
  assert.equal((await draft).code, "55P03");
  assert.equal((await final).status, "submitted");
  assert.deepEqual(calls, ["save_advice_transfer_draft", "submit_advice_transfer_payload"]);
});

test("departure cannot shorten the lease during an in-flight save", async () => {
  const gate = deferred();
  const calls = [];
  const transport = createStudyTransport({ fetchImpl: async (url) => {
    calls.push(url.split("/").at(-1)); await gate.promise; return response();
  } });
  const save = transport.request(config, "submit_advice_transfer_payload", payload());
  transport.keepalive(config, "mark_advice_transfer_departure", payload());
  assert.equal(calls.length, 1);
  gate.resolve(); await save; await flush();
  transport.keepalive(config, "mark_advice_transfer_departure", payload());
  assert.deepEqual(calls, ["submit_advice_transfer_payload", "mark_advice_transfer_departure"]);
});

test("closed and busy admission recover by polling and successful admission exits the waiting state", () => {
  const states = [
    { admissionStatus: "closed" },
    { admissionStatus: "waiting", reason: "server_busy", retryAfterMs: 750 },
    { admissionStatus: "waiting", queuePosition: 3, retryAfterMs: 3_000 },
    { assignmentId: "A", status: "claimed" },
  ].map((state) => admissionWait(state, () => 0.5));
  assert.equal(states[0].info.closed, true);
  assert.equal(states[0].delay, 10_000);
  assert.equal(states[1].info.reconnecting, true);
  assert.equal(states[1].info.queuePosition, null);
  assert.equal(states[1].delay, 750);
  assert.equal(states[2].info.queuePosition, 3);
  assert.equal(states[3], null);
  assert.equal(jitterDelay(1_000, () => 0), 750);
  assert.equal(jitterDelay(1_000, () => 1), 1_250);
});

test("a lost comprehension receipt retains the same event across retries and refresh, without creating a second failure", async () => {
  const event = newComprehensionEvent("wrong-option");
  const local = JSON.parse(JSON.stringify({ assignmentId: "A", savedAt: "2026-09-05T12:00:00Z", pendingComprehension: event }));
  const recovered = restoreComprehensionEvent("A", [local]);
  assert.deepEqual(recovered, event);
  assert.equal(restoreComprehensionEvent("B", [local]), null);
  let failures = 0;
  let calls = 0;
  const events = new Set();
  const transport = createStudyTransport({ sleep: async () => {}, fetchImpl: async (_url, options) => {
    const id = JSON.parse(options.body).p_payload.clientEventId;
    if (!events.has(id)) { events.add(id); failures += 1; }
    if (calls++ === 0) throw new Error("receipt lost after commit");
    return response({ status: "claimed", comprehensionFailures: failures });
  } });
  const result = await transport.request(config, "record_advice_transfer_comprehension_failure", {
    p_assignment_id: "A", p_selected_option: recovered.selectedOption,
    p_payload: { clientEventId: recovered.clientEventId },
  }, [0, 1]);
  assert.equal(result.comprehensionFailures, 1);
  assert.equal(calls, 2);
  const acknowledged = { ...local, savedAt: "2026-09-05T12:00:05Z", pendingComprehension: null };
  assert.equal(restoreComprehensionEvent("A", [local, acknowledged]), null);
});

// Execute the actual client callbacks with injected state/network boundaries.
// These tests exercise payload and local-backup behavior, not source patterns.
test("both actual comprehension callbacks preserve the pending event and clear stale correct selections on lost receipt", async () => {
  for (const filename of ["AdviceTransferTask.jsx", "LegacyAdviceTransferTask.jsx"]) {
    const source = await readFile(new URL(`../src/${filename}`, import.meta.url), "utf8");
    const start = source.indexOf("  const handleComprehension = async (selectedOption) => {");
    const callback = source.slice(start, source.indexOf("\n  useEffect", start));
    const requests = [];
    const backups = [];
    const state = {
      assignment: { assignmentId: "A", status: "claimed", participant: { prolificPid: "qa-network" }, config },
      comprehensionInFlight: { current: false }, pendingComprehensionRef: { current: null },
      phase1ReadOnly: false, CORRECT_COMPREHENSION: "correct", SCHEMA_VERSION: "test",
      newComprehensionEvent, nowIso: () => "2026-09-05T12:00:00Z",
      freshDraft: () => ({ assignmentId: "A", comprehension: "correct" }),
      writeLocalDraft: (_participant, backup) => backups.push(JSON.parse(JSON.stringify(backup))),
      clearLocalDraft: () => assert.fail("One unacknowledged event must not screen out"),
      setComprehension: () => {}, setComprehensionError: () => {},
      setTimestamps: () => {}, setComprehensionSaving: () => {},
      setComprehensionAttempts: (count) => { state.count = count; },
      setAssignment: () => {}, setDraftReady: () => {}, setScreen: () => {}, goTop: () => {},
      window: { alert: () => {} },
      supabaseRpcWithRetry: async (_config, _method, request) => {
        requests.push(JSON.parse(JSON.stringify(request)));
        if (requests.length === 1) throw new Error("Confirmation lost");
        return { status: "claimed", comprehensionFailures: 1, screenedOut: false };
      },
    };
    const run = vm.runInNewContext(`${callback}; handleComprehension`, state);
    await run("wrong");
    assert.equal(backups[0].comprehension, "", filename);
    assert.ok(state.pendingComprehensionRef.current?.clientEventId, filename);
    await run("correct"); // Confirm the outstanding event before accepting another answer.
    assert.equal(requests.length, 2, filename);
    assert.equal(requests[0].p_payload.clientEventId, requests[1].p_payload.clientEventId, filename);
    assert.equal(requests[1].p_selected_option, "wrong", filename);
    assert.equal(state.count, 1, filename);
    assert.equal(state.pendingComprehensionRef.current, null, filename);
    assert.equal(backups.at(-1).pendingComprehension, null, filename);
  }
});

test("the actual legacy final callback and autosave snapshot preserve one final payload through failure and retry", async () => {
  const source = await readFile(new URL("../src/LegacyAdviceTransferTask.jsx", import.meta.url), "utf8");
  const draftStart = source.indexOf("  const freshDraft =");
  const draftCallback = source.slice(draftStart, source.indexOf("\n  const recoverSession", draftStart));
  const finalStart = source.indexOf("  const submitStudy = async () => {");
  const finalCallback = source.slice(finalStart, source.indexOf("\n  useEffect", finalStart));
  const requests = [];
  const backups = [];
  let clock = 0;
  const state = {
    assignment: { assignmentId: "A", participant: { prolificPid: "qa-legacy" }, config,
      exposurePost: { postId: "post1", sha256: "hash1" }, targetPost: { postId: "post2", sha256: "hash2" } },
    wordCount: 77, MIN_ADVICE_WORDS: 77, advice: Array(77).fill("opinion").join(" "),
    difficulty: 4, effort: 4, confidence: 4, purposeGuess: "opinions",
    commentsStoodOut: "yes", commentsStoodOutDetails: "reason", aiGeneratedBelief: "yes", aiLikelihood: 7,
    timestamps: {}, submissionState: "idle", SCHEMA_VERSION: "advice-transfer-v3-admission",
    pendingSubmissionRef: { current: null }, pendingComprehensionRef: { current: null }, finalInFlight: { current: false },
    draftPayload: { assignmentId: "A", advice: "original", screen: "funnel-ai" },
    nowIso: () => new Date(Date.UTC(2026, 8, 5, 12, 0, clock++)).toISOString(), elapsedMs: () => 0,
    navigator: { userAgent: "test", language: "en" }, window: { innerWidth: 1000, innerHeight: 700 },
    SUBMIT_RETRY_DELAYS_MS: [0],
    setSubmissionState: (value) => { state.submissionState = value; },
    setSubmissionError: () => {}, setTimestamps: () => {}, setAssignment: () => {},
    setSaveState: () => {}, setScreen: () => {}, goTop: () => {},
    writeLocalDraft: (_participant, backup) => backups.push(JSON.parse(JSON.stringify(backup))),
    clearLocalDraft: () => { state.cleared = true; },
    supabaseRpcWithRetry: async (_config, _method, request) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      if (requests.length === 1) throw new Error("Confirmation lost");
      return { ok: true, status: "submitted" };
    },
  };
  const client = vm.runInNewContext(`${draftCallback}\n${finalCallback}; ({ submitStudy, freshDraft })`, state);
  await client.submitStudy();
  assert.equal(state.submissionState, "error");
  assert.equal(state.cleared, undefined);
  const autosaveAfterFailure = client.freshDraft();
  assert.deepEqual(JSON.parse(JSON.stringify(autosaveAfterFailure.pendingSubmission)), requests[0].p_payload);
  state.aiLikelihood = 1;
  await client.submitStudy();
  assert.deepEqual(requests[1].p_payload, requests[0].p_payload);
  assert.equal(state.submissionState, "submitted");
  assert.equal(state.pendingSubmissionRef.current, null);
  assert.equal(state.cleared, true);
  assert.equal(backups[0].pendingSubmission.aiLikelihood, 7);
});
