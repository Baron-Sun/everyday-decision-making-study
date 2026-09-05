import { admissionWait, jitterDelay, newComprehensionEvent, restoreComprehensionEvent, supabaseRpcWithRetry, supabaseRpcKeepalive } from "./advice-transfer-network.mjs";
export { supabaseRpcWithRetry } from "./advice-transfer-network.mjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ADVICE_TRANSFER_CONSENT_TEXT } from "./advice-transfer-legacy-consent";

const CORRECT_COMPREHENSION = "read-then-advise";
const SCHEMA_VERSION = "advice-transfer-v3-admission";
const HEARTBEAT_INTERVAL_MS = 30_000;
const DRAFT_SAVE_DELAY_MS = 1_500;
export const MIN_ADVICE_WORDS = 77;
const AITA_RESPONSE_GUIDANCE =
  "Imagine you are commenting on this post in Reddit’s r/AmItheAsshole community. First, give one judgment label: YTA, NTA, ESH, NAH, or INFO. Then explain your reasoning and give the poster constructive advice. Focus on the behavior described in the post and do not insult or attack anyone.";
const CLAIM_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 6_000];
const SUBMIT_RETRY_DELAYS_MS = [0, 750, 1_500, 3_000, 5_000];
const PROLIFIC_COMPLETION_BASE_URL =
  "https://app.prolific.com/submissions/complete";
const DRAFTABLE_SCREENS = new Set([
  "overview",
  "consent",
  "instructions",
  "exposure",
  "advice",
  "ratings",
  "funnel-purpose",
  "funnel-notice",
  "funnel-ai",
]);
const RESTORABLE_SCREENS = new Set(DRAFTABLE_SCREENS);

const nowIso = () => new Date().toISOString();
const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const storageKeyFor = ({ prolificPid, studyId, sessionId }) =>
  [
    "advice-transfer-v3",
    prolificPid,
    studyId || "study",
    isTestParticipant(prolificPid) ? sessionId || "session" : "formal",
  ].join(":");

const legacyStorageKeysFor = ({ prolificPid, studyId, sessionId }) => [
  ["advice-transfer-v3", prolificPid, studyId || "study", sessionId || "session"].join(":"),
  ["advice-transfer-v2", prolificPid, studyId || "study", sessionId || "session"].join(":"),
];

const readLocalDraft = (participant) => {
  for (const key of [storageKeyFor(participant), ...legacyStorageKeysFor(participant)]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {
      // Continue to the next backward-compatible key.
    }
  }
  return null;
};

const writeLocalDraft = (participant, payload) => {
  try {
    window.localStorage.setItem(storageKeyFor(participant), JSON.stringify(payload));
  } catch {
    // Server autosave remains available if local storage is blocked.
  }
};

const clearLocalDraft = (participant) => {
  for (const key of [storageKeyFor(participant), ...legacyStorageKeysFor(participant)]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // A stale local backup is harmless because submitted sessions bypass it.
    }
  }
};

export const countEnglishWords = (value) =>
  String(value || "").match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length || 0;

const elapsedMs = (start, end) => {
  if (!start || !end) return 0;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
};

const cleanParameter = (value) => {
  if (!value || value.includes("{{%") || value.includes("%}}")) return "";
  return value.trim();
};

const getQueryParams = () => new URLSearchParams(window.location.search);

const getParticipant = () => {
  const params = getQueryParams();
  return {
    prolificPid: cleanParameter(
      params.get("PROLIFIC_PID") || params.get("prolific_pid"),
    ),
    studyId: cleanParameter(params.get("STUDY_ID") || params.get("study_id")),
    sessionId: cleanParameter(
      params.get("SESSION_ID") || params.get("session_id"),
    ),
  };
};

export const isTestParticipant = (prolificPid) =>
  /^(test|preview|qa)[-_]/i.test(prolificPid);

const getTestOverrides = (prolificPid) => {
  const params = getQueryParams();
  const pairText = cleanParameter(params.get("pair"));
  const conditionText = cleanParameter(params.get("condition")).toLowerCase();

  if (!isTestParticipant(prolificPid)) {
    return { pairNumber: null, condition: null };
  }

  if (pairText && !/^(?:[1-9]|1[0-3])$/.test(pairText)) {
    throw new Error("The test parameter pair must be an integer from 1 to 13.");
  }
  if (conditionText && !["human", "ai"].includes(conditionText)) {
    throw new Error("The test parameter condition must be human or ai.");
  }

  return {
    pairNumber: pairText ? Number(pairText) : null,
    condition: conditionText || null,
  };
};

const getSupabaseConfig = () => {
  const url = String(import.meta.env.VITE_SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const anonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
};

const getCompletion = () => {
  const params = getQueryParams();
  const code = cleanParameter(
    params.get("completion_code") ||
      params.get("COMPLETION_CODE") ||
      import.meta.env.VITE_ADVICE_TRANSFER_COMPLETION_CODE,
  );
  if (!code || !/^[A-Za-z0-9_-]{3,80}$/.test(code)) {
    return { code: "", url: "" };
  }
  return {
    code,
    url: `${PROLIFIC_COMPLETION_BASE_URL}?cc=${encodeURIComponent(code)}`,
  };
};

export const validateAdviceTransferAssignment = (value) => {
  if (!value?.assignmentId || !value?.exposurePost || !value?.targetPost) {
    throw new Error("The assigned study material was incomplete.");
  }
  if (Object.prototype.hasOwnProperty.call(value, "condition")) {
    throw new Error("The assignment disclosed information that should remain masked.");
  }
  if (
    value.exposurePost.postId === value.targetPost.postId ||
    !value.exposurePost.title ||
    !value.exposurePost.body ||
    !value.targetPost.title ||
    !value.targetPost.body
  ) {
    throw new Error("The assigned post pair failed its completeness check.");
  }
  for (const post of [value.exposurePost, value.targetPost]) {
    if (!/^[a-f0-9]{64}$/i.test(String(post.sha256 || ""))) {
      throw new Error("An assigned post failed its audit-hash check.");
    }
  }
  if (
    !Array.isArray(value.comments) ||
    value.comments.length !== 5 ||
    !Array.isArray(value.commentHashes) ||
    value.commentHashes.length !== 5 ||
    !Array.isArray(value.commentOrder) ||
    value.commentOrder.length !== 5
  ) {
    throw new Error("The assigned comment set failed its completeness check.");
  }
  if (
    value.comments.some(
      (comment) =>
        !String(comment).trim() ||
        /[^\x09\x0a\x0d\x20-\x7e]/.test(String(comment)) ||
        /[\\*]/.test(String(comment)),
    )
  ) {
    throw new Error("The assigned comment set was not fully cleaned.");
  }
  if (
    value.commentHashes.some(
      (hash) => !/^[a-f0-9]{64}$/i.test(String(hash || "")),
    )
  ) {
    throw new Error("An assigned comment failed its audit-hash check.");
  }
  const sortedOrder = [...value.commentOrder].map(Number).sort((a, b) => a - b);
  if (sortedOrder.join(",") !== "0,1,2,3,4") {
    throw new Error("The comment order was not a valid five-item permutation.");
  }
};

const useGlobalClipboardBlock = () => {
  useEffect(() => {
    const blockClipboard = (event) => {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
    };
    const blockedEvents = [
      "copy",
      "cut",
      "paste",
      "drop",
      "dragstart",
      "contextmenu",
    ];
    blockedEvents.forEach((eventName) =>
      document.addEventListener(eventName, blockClipboard, true),
    );
    return () =>
      blockedEvents.forEach((eventName) =>
        document.removeEventListener(eventName, blockClipboard, true),
      );
  }, []);
};

const StudyHeader = ({ ready = false }) => (
  <header className="source-study-header">
    <div>
      <p className="source-institution">Northwestern University Research Study</p>
      <h1>Study About Online Opinions</h1>
    </div>
    <div className="source-session-card" aria-label="Research session status">
      <strong>Research Session</strong>
      <span>{ready ? "Assignment ready" : "Preparing…"}</span>
    </div>
  </header>
);

const PrimaryButton = ({ children, disabled = false, onClick }) => (
  <button
    type="button"
    className="source-primary-button"
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);

const SecondaryButton = ({ children, onClick }) => (
  <button type="button" className="source-secondary-button" onClick={onClick}>
    {children}
  </button>
);

const Page = ({ children, wide = false, ready = true }) => (
  <main className="source-study-page transfer-study-page">
    <div
      className={`source-page-wrap ${wide ? "source-wide-wrap" : "source-narrow-wrap"}`}
    >
      <StudyHeader ready={ready} />
      {children}
    </div>
  </main>
);

const PostPanel = ({ eyebrow, post, adviceTarget = false }) => (
  <article className="source-panel source-post-panel transfer-post-panel">
    <div className="source-panel-heading">
      <p className="source-eyebrow">{eyebrow}</p>
      {adviceTarget && (
        <p className="transfer-advice-prompt">
          {AITA_RESPONSE_GUIDANCE}
        </p>
      )}
      <h2>{post.title}</h2>
    </div>
    <div className="source-post-text">{post.body}</div>
  </article>
);

const ScaleQuestion = ({ legend, value, onChange, low, middle, high, disabled = false }) => (
  <fieldset className="transfer-scale-fieldset" disabled={disabled}>
    <legend>{legend}</legend>
    <div className="source-rating-options transfer-rating-options">
      {[1, 2, 3, 4, 5, 6, 7].map((number) => (
        <label
          className={`source-rating-option ${value === number ? "selected" : ""}`}
          key={number}
        >
          <input
            type="radio"
            name={legend}
            value={number}
            checked={value === number}
            onChange={() => onChange(number)}
          />
          <span>{number}</span>
        </label>
      ))}
    </div>
    <div className="source-rating-anchors transfer-rating-anchors">
      <span><b>1</b> — {low}</span>
      <span><b>4</b> — {middle}</span>
      <span><b>7</b> — {high}</span>
    </div>
  </fieldset>
);

const ThreeWayChoice = ({ name, value, onChange, disabled = false }) => (
  <div className="transfer-choice-row" role="radiogroup">
    {[
      ["yes", "Yes"],
      ["no", "No"],
      ["unsure", "Unsure"],
    ].map(([optionValue, label]) => (
      <label
        key={optionValue}
        className={`transfer-choice ${value === optionValue ? "selected" : ""}`}
      >
        <input
          type="radio"
          name={name}
          disabled={disabled}
          value={optionValue}
          checked={value === optionValue}
          onChange={() => onChange(optionValue)}
        />
        {label}
      </label>
    ))}
  </div>
);

const SaveStatus = ({ state }) => {
  const message = {
    saving: "Saving your progress…",
    saved: "Progress saved",
    offline: "Progress is saved on this device and will sync automatically.",
  }[state];
  if (!message) return null;
  return (
    <p className={`transfer-save-status ${state}`} role="status" aria-live="polite">
      {message}
    </p>
  );
};

export default function LegacyAdviceTransferTask() {
  useGlobalClipboardBlock();

  const [screen, setScreen] = useState("loading");
  const [assignment, setAssignment] = useState(null);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [comprehension, setComprehension] = useState("");
  const [comprehensionAttempts, setComprehensionAttempts] = useState(0);
  const [comprehensionError, setComprehensionError] = useState("");
  const [comprehensionSaving, setComprehensionSaving] = useState(false);
  const pendingComprehensionRef = useRef(null);
  const comprehensionInFlight = useRef(false);
  const [advice, setAdvice] = useState("");
  const [difficulty, setDifficulty] = useState(null);
  const [effort, setEffort] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [purposeGuess, setPurposeGuess] = useState("");
  const [commentsStoodOut, setCommentsStoodOut] = useState("");
  const [commentsStoodOutDetails, setCommentsStoodOutDetails] = useState("");
  const [aiGeneratedBelief, setAiGeneratedBelief] = useState("");
  const [aiLikelihood, setAiLikelihood] = useState(null);
  const [timestamps, setTimestamps] = useState({});
  const [submissionState, setSubmissionState] = useState("idle");
  const [submissionError, setSubmissionError] = useState("");
  const pendingSubmissionRef = useRef(null);
  const finalInFlight = useRef(false);
  const recoverSessionRef = useRef(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [waitingInfo, setWaitingInfo] = useState(null);
  const completion = useMemo(() => getCompletion(), []);
  const wordCount = useMemo(() => countEnglishWords(advice), [advice]);
  const draftPayload = useMemo(() => {
    if (!assignment || !DRAFTABLE_SCREENS.has(screen)) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      assignmentId: assignment.assignmentId,
      savedAt: nowIso(),
      screen,
      agreed,
      comprehension,
      pendingComprehension: pendingComprehensionRef.current,
      advice,
      difficulty,
      effort,
      confidence,
      purposeGuess,
      commentsStoodOut,
      commentsStoodOutDetails,
      aiGeneratedBelief,
      aiLikelihood,
      timestamps,
      pendingSubmission: pendingSubmissionRef.current,
    };
  }, [
    assignment?.assignmentId,
    screen,
    agreed,
    comprehension,
    comprehensionSaving,
    advice,
    difficulty,
    effort,
    confidence,
    purposeGuess,
    commentsStoodOut,
    commentsStoodOutDetails,
    aiGeneratedBelief,
    aiLikelihood,
    timestamps,
    submissionState,
  ]);

  const freshDraft = (draft = draftPayload) => draft ? {
    ...draft,
    savedAt: nowIso(),
    pendingSubmission: pendingSubmissionRef.current,
    pendingComprehension: pendingComprehensionRef.current,
  } : null;

  const recoverSession = () => {
    if (assignment && draftPayload) writeLocalDraft(assignment.participant, freshDraft());
    setSaveState("offline");
    setDraftReady(false);
    setAssignment(null);
    setError("");
    setScreen("loading");
    setLoadNonce((current) => current + 1);
  };

  recoverSessionRef.current = recoverSession;

  useEffect(() => {
    let active = true;
    const participant = getParticipant();
    const config = getSupabaseConfig();
    setDraftReady(false);

    if (!participant.prolificPid) {
      setError(
        "Missing PROLIFIC_PID. Open the study from Prolific, or use a test-, preview-, or qa- identifier when reviewing it.",
      );
      setScreen("error");
      return () => {
        active = false;
      };
    }
    if (!config) {
      setError("The study database is not configured.");
      setScreen("error");
      return () => {
        active = false;
      };
    }
    if (!isTestParticipant(participant.prolificPid) && !completion.url) {
      setError(
        "This formal study link is missing its Prolific completion code. Please return to Prolific and contact the researcher.",
      );
      setScreen("error");
      return () => {
        active = false;
      };
    }

    let overrides;
    try {
      overrides = getTestOverrides(participant.prolificPid);
    } catch (parameterError) {
      setError(parameterError.message);
      setScreen("error");
      return () => {
        active = false;
      };
    }

    const claimPayload = {
      p_prolific_pid: participant.prolificPid,
      p_study_id: participant.studyId || null,
      p_session_id: participant.sessionId || null,
      p_is_test: isTestParticipant(participant.prolificPid),
      p_pair_number: overrides.pairNumber,
      p_condition: overrides.condition,
    };

    const prepareSession = async () => {
      let response;
      while (active) {
        try {
          response = await supabaseRpcWithRetry(
            config,
            "claim_advice_transfer_assignment",
            claimPayload,
            CLAIM_RETRY_DELAYS_MS,
          );
        } catch (loadError) {
          if (!active) return;
          if (loadError?.retryable) {
            setWaitingInfo((current) => ({
              ...(current || {}),
              reconnecting: true,
            }));
            setScreen("waiting");
            await wait(jitterDelay(3_000));
            continue;
          }
          setError(
            loadError instanceof Error
              ? loadError.message
              : "The study could not be loaded.",
          );
          setScreen("error");
          return;
        }

        if (!active) return;
        if (response?.admissionStatus === "waiting" || response?.admissionStatus === "closed") {
          const waiting = admissionWait(response);
          setWaitingInfo(waiting.info);
          setScreen("waiting");
          await wait(waiting.delay);
          continue;
        }
        break;
      }

      if (!active || !response) return;
      try {
        validateAdviceTransferAssignment(response);
        const nextAssignment = { ...response, participant, config };
        const failures = Number(response.comprehensionFailures) || 0;
        setAssignment(nextAssignment);
        setComprehensionAttempts(failures);
        if (response.status === "screened_out" || failures >= 2) {
          clearLocalDraft(participant);
          setDraftReady(true);
          setScreen("comprehension-failed");
        } else if (response.status === "submitted") {
          clearLocalDraft(participant);
          setAlreadySubmitted(true);
          setDraftReady(true);
          setScreen("complete");
        } else {
          const serverDraft = response.draftPayload;
          const localDraft = readLocalDraft(participant);
          const candidates = [serverDraft, localDraft]
            .filter(
              (draft) =>
                draft &&
                draft.assignmentId === response.assignmentId &&
                RESTORABLE_SCREENS.has(draft.screen),
            )
            .sort(
              (left, right) =>
                new Date(right.savedAt || 0).getTime() -
                new Date(left.savedAt || 0).getTime(),
            );
          const restored = candidates[0] || null;
          pendingSubmissionRef.current = restored?.pendingSubmission || null;
          pendingComprehensionRef.current = restoreComprehensionEvent(response.assignmentId, [localDraft, serverDraft]);
          if (pendingComprehensionRef.current) setComprehensionError("Reconnecting to confirm your previous answer.");
          if (restored) {
            const scaleValue = (value) => {
              const number = Number(value);
              return Number.isInteger(number) && number >= 1 && number <= 7
                ? number
                : null;
            };
            const restoredAgreed = Boolean(restored.agreed);
            const restoredComprehension =
              restored.comprehension === CORRECT_COMPREHENSION
                ? CORRECT_COMPREHENSION
                : "";
            let restoredScreen = restored.screen;
            if (restoredScreen !== "overview" && !restoredAgreed) {
              restoredScreen = "consent";
            } else if (
              !["overview", "consent", "instructions"].includes(restoredScreen) &&
              restoredComprehension !== CORRECT_COMPREHENSION
            ) {
              restoredScreen = "instructions";
            }
            setAgreed(restoredAgreed);
            setComprehension(restoredComprehension);
            setAdvice(String(restored.advice || ""));
            setDifficulty(scaleValue(restored.difficulty));
            setEffort(scaleValue(restored.effort));
            setConfidence(scaleValue(restored.confidence));
            setPurposeGuess(String(restored.purposeGuess || ""));
            setCommentsStoodOut(
              ["yes", "no", "unsure"].includes(restored.commentsStoodOut)
                ? restored.commentsStoodOut
                : "",
            );
            setCommentsStoodOutDetails(
              String(restored.commentsStoodOutDetails || ""),
            );
            setAiGeneratedBelief(
              ["yes", "no", "unsure"].includes(restored.aiGeneratedBelief)
                ? restored.aiGeneratedBelief
                : "",
            );
            setAiLikelihood(scaleValue(restored.aiLikelihood));
            setTimestamps(
              restored.timestamps && typeof restored.timestamps === "object"
                ? restored.timestamps
                : {},
            );
            if (restored.pendingSubmission) {
              setSubmissionState("submitting");
              try {
                const result = await supabaseRpcWithRetry(
                  config,
                  "submit_advice_transfer_payload",
                  {
                    p_assignment_id: response.assignmentId,
                    p_payload: restored.pendingSubmission,
                  },
                  SUBMIT_RETRY_DELAYS_MS,
                );
                if (!result.ok || result.status !== "submitted") throw new Error("Submission confirmation is incomplete. Please retry.");
                pendingSubmissionRef.current = null;
                clearLocalDraft(participant);
                setAssignment((current) => ({
                  ...(current || nextAssignment),
                  status: result.status || "submitted",
                  submittedAt: result.submittedAt || nowIso(),
                }));
                setSubmissionState("submitted");
                setDraftReady(true);
                setScreen("debrief");
                return;
              } catch {
                setSubmissionState("error");
                setSubmissionError(
                  "Your responses were recovered and remain saved. We are still reconnecting; please select Retry submission if the automatic retry does not finish.",
                );
                restoredScreen = "funnel-ai";
              }
            }
            setScreen(restoredScreen);
          } else {
            setScreen("overview");
          }
          setDraftReady(true);
        }
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "The study could not be loaded.");
        setScreen("error");
      }
    };

    prepareSession();

    return () => {
      active = false;
    };
  }, [loadNonce]);

  useEffect(() => {
    if (!assignment || assignment.status !== "claimed") return undefined;
    let active = true;
    let heartbeatInFlight = false;

    const heartbeat = async () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        const result = await supabaseRpcWithRetry(
          assignment.config,
          "heartbeat_advice_transfer_assignment",
          {
            p_assignment_id: assignment.assignmentId,
            p_prolific_pid: assignment.participant.prolificPid,
          },
          [0, 1_000],
        );
        if (!active) return;
        if (result.status === "submitted") {
          clearLocalDraft(assignment.participant);
          setAlreadySubmitted(true);
          setSubmissionState("submitted");
          setAssignment((current) =>
            current ? { ...current, status: "submitted" } : current,
          );
          setScreen("complete");
          return;
        }
        if (result.status === "screened_out") {
          clearLocalDraft(assignment.participant);
          setAssignment((current) =>
            current ? { ...current, status: "screened_out" } : current,
          );
          setScreen("comprehension-failed");
          return;
        }
        if (result.active === false || result.status !== "claimed") {
          recoverSessionRef.current();
          return;
        }
        setAssignment((current) =>
          current
            ? {
                ...current,
                status: result.status || current.status,
                leaseExpiresAt: result.leaseExpiresAt || current.leaseExpiresAt,
              }
            : current,
        );
      } catch {
        if (active) setSaveState("offline");
      } finally {
        heartbeatInFlight = false;
      }
    };

    let intervalId;
    const scheduleHeartbeat = () => {
      intervalId = window.setTimeout(async () => {
        await heartbeat();
        if (active) scheduleHeartbeat();
      }, jitterDelay(HEARTBEAT_INTERVAL_MS));
    };
    scheduleHeartbeat();
    const onOnline = () => heartbeat();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") heartbeat();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearTimeout(intervalId);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [assignment?.assignmentId, assignment?.status]);

  useEffect(() => {
    if (!assignment || assignment.status !== "claimed") return undefined;
    const noteDeparture = (event) => {
      if (event?.persisted) return;
      const departureDraft = freshDraft();
      if (departureDraft) writeLocalDraft(assignment.participant, departureDraft);
      supabaseRpcKeepalive(
        assignment.config,
        "mark_advice_transfer_departure",
        {
          p_assignment_id: assignment.assignmentId,
          p_prolific_pid: assignment.participant.prolificPid,
          p_draft_payload: departureDraft,
        },
      );
    };
    const warnBeforeUnload = (event) => {
      if (["overview", "consent", "debrief", "complete"].includes(screen)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", noteDeparture);
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", noteDeparture);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [assignment?.assignmentId, assignment?.status, draftPayload, screen]);

  useEffect(() => {
    if (
      !draftReady ||
      !assignment ||
      assignment.status !== "claimed" ||
      !draftPayload ||
      submissionState === "submitted"
    ) {
      return undefined;
    }

    writeLocalDraft(assignment.participant, freshDraft());
    let active = true;
    const timeoutId = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        const result = await supabaseRpcWithRetry(
          assignment.config,
          "save_advice_transfer_draft",
          {
            p_assignment_id: assignment.assignmentId,
            p_prolific_pid: assignment.participant.prolificPid,
            p_payload: freshDraft(),
          },
          [0, 750, 1_500],
        );
        if (!active) return;
        if (result.alreadySubmitted) {
          clearLocalDraft(assignment.participant);
          setAlreadySubmitted(true);
          setSubmissionState("submitted");
          setScreen("complete");
          return;
        }
        if (!result.ok || result.saved === false || result.status !== "claimed") {
          setSaveState("offline");
          recoverSessionRef.current();
          return;
        }
        setAssignment((current) =>
          current
            ? {
                ...current,
                leaseExpiresAt: result.leaseExpiresAt || current.leaseExpiresAt,
              }
            : current,
        );
        setSaveState("saved");
      } catch {
        if (active) setSaveState("offline");
      }
    }, DRAFT_SAVE_DELAY_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [assignment?.assignmentId, assignment?.status, draftPayload, draftReady, submissionState]);

  const goTop = () => window.scrollTo({ top: 0, behavior: "auto" });

  const returnToScreen = (previousScreen) => {
    if (submissionState === "submitting" || pendingSubmissionRef.current || comprehensionInFlight.current) return;
    setScreen(previousScreen);
    goTop();
  };

  const beginConsent = () => {
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      studyStartedAt: current.studyStartedAt || time,
    }));
    setScreen("consent");
    goTop();
  };

  const acceptConsent = () => {
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      consentedAt: time,
      instructionsOpenedAt: time,
    }));
    setScreen("instructions");
    goTop();
  };

  const declineConsent = async () => {
    if (!assignment) return;
    clearLocalDraft(assignment.participant);
    setDraftReady(false);
    setAssignment((current) =>
      current ? { ...current, status: "abandoned" } : current,
    );
    setScreen("declined");
    goTop();
    try {
      const result = await supabaseRpcWithRetry(
        assignment.config,
        "withdraw_advice_transfer_assignment",
        {
          p_assignment_id: assignment.assignmentId,
          p_prolific_pid: assignment.participant.prolificPid,
          p_reason: "consent_declined",
        },
        [0, 750, 1_500],
      );
      setAssignment((current) =>
        current ? { ...current, status: result.status || "abandoned" } : current,
      );
    } catch {
      // The renewable lease will expire automatically if immediate release fails.
    }
  };

  const handleComprehension = async (selectedOption) => {
    if (!assignment || assignment.status !== "claimed" || !selectedOption || comprehensionInFlight.current) return;
    if (selectedOption === CORRECT_COMPREHENSION && !pendingComprehensionRef.current) {
      setComprehension(selectedOption);
      setComprehensionError("");
      return;
    }

    comprehensionInFlight.current = true;
    const event = pendingComprehensionRef.current || newComprehensionEvent(selectedOption);
    pendingComprehensionRef.current = event;
    setComprehensionSaving(true);
    setComprehension("");
    setComprehensionError("");
    writeLocalDraft(assignment.participant, { ...freshDraft(), comprehension: "", pendingComprehension: event });
    try {
      const result = await supabaseRpcWithRetry(
        assignment.config,
        "record_advice_transfer_comprehension_failure",
        {
          p_assignment_id: assignment.assignmentId,
          p_selected_option: event.selectedOption,
          p_payload: {
            schemaVersion: SCHEMA_VERSION,
            clientEventId: event.clientEventId,
            occurredAt: event.occurredAt,
            participant: assignment.participant,
          },
        },
      );
      const failures = Number(result.comprehensionFailures);
      if (!Number.isInteger(failures) || failures < 1 || !["claimed", "screened_out"].includes(result.status)) {
        throw new Error("The comprehension-check result could not yet be confirmed.");
      }
      pendingComprehensionRef.current = null;
      writeLocalDraft(assignment.participant, { ...freshDraft(), comprehension: "", pendingComprehension: null });
      const screenedOut = Boolean(result.screenedOut) || failures >= 2;
      setComprehensionAttempts(failures);
      setAssignment((current) => current ? { ...current, status: result.status || current.status } : current);
      if (screenedOut) {
        clearLocalDraft(assignment.participant);
        setDraftReady(false);
        setScreen("comprehension-failed");
        goTop();
        return;
      }
      setComprehensionError("Incorrect. Please read the instructions and try once more.");
      window.alert("Incorrect. Please read the instructions and try once more.");
    } catch (saveError) {
      setComprehensionError(saveError instanceof Error ? saveError.message : "The comprehension-check result could not be saved.");
    } finally {
      comprehensionInFlight.current = false;
      setComprehensionSaving(false);
    }
  };

  useEffect(() => {
    if (!draftReady || comprehensionSaving || !comprehensionError || !pendingComprehensionRef.current || assignment?.status !== "claimed") return undefined;
    const retry = () => {
      if (navigator.onLine && document.visibilityState === "visible" && pendingComprehensionRef.current) {
        handleComprehension(pendingComprehensionRef.current.selectedOption);
      }
    };
    const timer = window.setTimeout(retry, jitterDelay(8_000));
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [draftReady, comprehensionSaving, comprehensionError, assignment?.assignmentId, assignment?.status]);

  const beginExposure = () => {
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      exposureOpenedAt: current.exposureOpenedAt || time,
    }));
    setScreen("exposure");
    goTop();
  };

  const continueToAdvice = () => {
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      exposureCompletedAt: current.exposureCompletedAt || time,
      targetOpenedAt: current.targetOpenedAt || time,
    }));
    setScreen("advice");
    goTop();
  };

  const updateAdvice = (event) => {
    const value = event.target.value;
    const time = nowIso();
    setAdvice(value);
    setTimestamps((current) => ({
      ...current,
      firstInputAt: current.firstInputAt || (value ? time : ""),
      lastEditAt: time,
    }));
  };

  const continueToRatings = () => {
    if (wordCount < MIN_ADVICE_WORDS) return;
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      adviceCompletedAt: time,
      ratingsOpenedAt: time,
    }));
    setScreen("ratings");
    goTop();
  };

  const continueToPurpose = () => {
    if ([difficulty, effort, confidence].some((value) => value === null)) return;
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      ratingsCompletedAt: time,
      funnelPurposeOpenedAt: time,
    }));
    setScreen("funnel-purpose");
    goTop();
  };

  const continueToNotice = () => {
    if (!purposeGuess.trim()) return;
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      funnelPurposeCompletedAt: time,
      funnelNoticeOpenedAt: time,
    }));
    setScreen("funnel-notice");
    goTop();
  };

  const continueToAi = () => {
    if (!commentsStoodOut) return;
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      funnelNoticeCompletedAt: time,
      funnelAiOpenedAt: time,
    }));
    setScreen("funnel-ai");
    goTop();
  };

  const submitStudy = async () => {
    if (
      !assignment ||
      wordCount < MIN_ADVICE_WORDS ||
      [difficulty, effort, confidence].some((value) => value === null) ||
      !purposeGuess.trim() ||
      !commentsStoodOut ||
      !aiGeneratedBelief ||
      aiLikelihood === null ||
      submissionState === "submitting" ||
      finalInFlight.current
    ) {
      return;
    }
    finalInFlight.current = true;
    setSubmissionState("submitting");
    setSubmissionError("");
    const submittedAt = nowIso();
    const finalTimestamps = {
      ...timestamps,
      funnelAiCompletedAt: submittedAt,
      clientSubmittedAt: submittedAt,
    };
    finalTimestamps.exposureTimeMs = elapsedMs(
      finalTimestamps.exposureOpenedAt,
      finalTimestamps.exposureCompletedAt,
    );
    finalTimestamps.adviceResponseTimeMs = elapsedMs(
      finalTimestamps.targetOpenedAt,
      finalTimestamps.adviceCompletedAt,
    );
    finalTimestamps.totalStudyTimeMs = elapsedMs(
      finalTimestamps.studyStartedAt,
      submittedAt,
    );

    const payload = pendingSubmissionRef.current || {
      schemaVersion: SCHEMA_VERSION,
      assignmentId: assignment.assignmentId,
      participant: assignment.participant,
      adviceText: advice.trim(),
      adviceWordCount: wordCount,
      adviceCharacterCount: advice.trim().length,
      difficulty,
      effort,
      confidence,
      purposeGuess: purposeGuess.trim(),
      commentsStoodOut,
      commentsStoodOutDetails: commentsStoodOutDetails.trim(),
      aiGeneratedBelief,
      aiLikelihood,
      timings: finalTimestamps,
      clientAudit: {
        pairNumber: assignment.pairNumber,
        pairRole: assignment.pairRole,
        exposurePostId: assignment.exposurePost.postId,
        exposurePostSha256: assignment.exposurePost.sha256,
        targetPostId: assignment.targetPost.postId,
        targetPostSha256: assignment.targetPost.sha256,
        commentOrder: assignment.commentOrder,
        commentHashes: assignment.commentHashes,
      },
      clientEnvironment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      },
    };

    pendingSubmissionRef.current = payload;
    writeLocalDraft(assignment.participant, {
      ...(freshDraft() || {}),
      assignmentId: assignment.assignmentId,
      savedAt: submittedAt,
      screen: "funnel-ai",
      pendingSubmission: payload,
    });

    try {
      const result = await supabaseRpcWithRetry(
        assignment.config,
        "submit_advice_transfer_payload",
        {
          p_assignment_id: assignment.assignmentId,
          p_payload: payload,
        },
        SUBMIT_RETRY_DELAYS_MS,
      );
      if (!result.ok || result.status !== "submitted") throw new Error("Submission confirmation is incomplete. Please retry.");
      pendingSubmissionRef.current = null;
      clearLocalDraft(assignment.participant);
      setTimestamps(payload.timings);
      setAssignment((current) => ({
        ...current,
        status: result.status || "submitted",
        submittedAt: result.submittedAt || submittedAt,
      }));
      setSubmissionState("submitted");
      setSaveState("saved");
      setScreen("debrief");
      goTop();
    } catch (submitError) {
      setSubmissionState("error");
      setSubmissionError(
        `Your responses are still saved on this device, but the final confirmation did not reach the study database. Please keep this page open and select Retry submission. ${
          submitError instanceof Error ? submitError.message : ""
        }`.trim(),
      );
    } finally {
      finalInFlight.current = false;
    }
  };

  useEffect(() => {
    if (submissionState !== "error" || !assignment) return undefined;
    const retryWhenReady = () => {
      if (navigator.onLine && document.visibilityState === "visible") {
        submitStudy();
      }
    };
    const timeoutId = window.setTimeout(retryWhenReady, jitterDelay(8_000));
    const onVisibilityChange = () => retryWhenReady();
    window.addEventListener("online", retryWhenReady);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("online", retryWhenReady);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submissionState, assignment?.assignmentId]);

  if (screen === "loading") {
    return (
      <main className="source-study-page source-centered-page">
        <div className="source-loading-card" role="status">
          <span className="source-loading-dot" />
          <strong>Preparing your research session…</strong>
          <p>Assigning study materials securely.</p>
        </div>
      </main>
    );
  }

  if (screen === "waiting") {
    return (
      <main className="source-study-page source-centered-page">
        <div className="source-loading-card transfer-waiting-card" role="status" aria-live="polite">
          <span className="source-loading-dot" />
          <strong>Your study place is being prepared…</strong>
          <p>
            Please keep this page open. The task will begin automatically as
            soon as a place becomes available; there is no need to refresh.
          </p>
          {waitingInfo?.queuePosition ? (
            <p className="transfer-queue-note">
              Current queue position: <b>{waitingInfo.queuePosition}</b>
            </p>
          ) : null}
          {waitingInfo?.closed ? (
            <p className="transfer-reconnect-note">
              New sessions are temporarily paused. This page will check automatically and continue when entry opens.
            </p>
          ) : waitingInfo?.reconnecting ? (
            <p className="transfer-reconnect-note">
              Reconnecting securely. This page will keep trying automatically.
            </p>
          ) : (
            <p className="transfer-reconnect-note">
              Your Prolific submission remains active while this page waits.
            </p>
          )}
        </div>
      </main>
    );
  }

  if (screen === "error") {
    return (
      <Page ready={false}>
        <section className="source-panel source-error-panel">
          <p className="source-eyebrow">Unable to open study</p>
          <h2>This research session could not be prepared.</h2>
          <p>{error}</p>
          <div className="transfer-action-row">
            <PrimaryButton
              onClick={() => {
                setError("");
                setScreen("loading");
                setLoadNonce((current) => current + 1);
              }}
            >
              Try again
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "overview") {
    return (
      <Page>
        <section className="source-panel source-intro-panel">
          <p className="source-eyebrow">Study overview</p>
          <h2>Read an online discussion and give thoughtful advice</h2>
          <p className="source-intro-copy">
            You will first read one public online post and five comments. You
            will then read a related but different post written by another
            Reddit user and write the advice you would give that user.
          </p>
          <div className="source-overview-grid">
            <div><span>Estimated time</span><strong>About 10–12 minutes</strong></div>
            <div><span>Writing task</span><strong>At least {MIN_ADVICE_WORDS} English words</strong></div>
            <div><span>Study material</span><strong>Reddit posts and comments</strong></div>
            <div><span>Important</span><strong>Complete the study in one sitting</strong></div>
          </div>
          <div className="source-intro-action">
            <div>
              <h3>Ready to review the consent form?</h3>
              <p>Your assigned material will remain the same if this page is refreshed.</p>
            </div>
            <PrimaryButton onClick={beginConsent}>Review consent</PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "consent") {
    return (
      <Page wide>
        <div className="source-consent-layout">
          <section className="source-panel source-consent-panel">
            <p className="source-eyebrow">Participant information</p>
            <h2>Informed Consent</h2>
            <div className="source-consent-text">{ADVICE_TRANSFER_CONSENT_TEXT}</div>
          </section>
          <aside className="source-panel source-consent-confirmation">
            <h3>Consent Confirmation</h3>
            <label className="source-consent-checkbox">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>
                I am at least 18 years old, I have read the consent information,
                and I voluntarily agree to participate.
              </span>
            </label>
            <div className="source-button-row">
              <SecondaryButton onClick={declineConsent}>I Disagree</SecondaryButton>
              <SecondaryButton onClick={() => returnToScreen("overview")}>Back</SecondaryButton>
              <PrimaryButton disabled={!agreed} onClick={acceptConsent}>I Agree</PrimaryButton>
            </div>
          </aside>
        </div>
      </Page>
    );
  }

  if (screen === "declined") {
    return (
      <Page>
        <section className="source-panel source-completion-panel">
          <p className="source-eyebrow">Participation declined</p>
          <h2>You have not consented to participate.</h2>
          <p>You may close this browser window. No task response was submitted.</p>
        </section>
      </Page>
    );
  }

  if (screen === "instructions") {
    return (
      <Page>
        <section className="source-panel source-intro-panel">
          <p className="source-eyebrow">Instructions and attention check</p>
          <h2>Please read these instructions carefully</h2>
          <div className="source-instructions-copy transfer-instructions">
            <p>
              First, read one online discussion post and all five anonymous
              comments responding to it. Next, you will see a <strong>related but
              different</strong> post written by another Reddit user. The earlier
              post and comments will no longer be visible, and you cannot return
              to them. Write the advice you would genuinely give that Reddit user in
              at least {MIN_ADVICE_WORDS} English words. Afterwards, answer brief questions about
              your experience and your impressions of the study. Back buttons are
              available for reviewing earlier responses, except across this
              discussion-to-advice boundary.
            </p>
            <div className="transfer-community-guidance">
              <h3>r/AmItheAsshole community guidance</h3>
              <p>{AITA_RESPONSE_GUIDANCE}</p>
              <p>
                <strong>AITA</strong> means “Am I the Asshole?” Begin your advice
                response with exactly one of the following judgment labels:
              </p>
              <ul>
                <li><strong>YTA — You're the Asshole:</strong> the poster is in the wrong, and the other party is not.</li>
                <li><strong>NTA — Not the Asshole:</strong> the poster is not in the wrong, and the other party is.</li>
                <li><strong>ESH — Everyone Sucks Here:</strong> the poster and the other party are both in the wrong.</li>
                <li><strong>NAH — No Assholes Here:</strong> no one is in the wrong.</li>
                <li><strong>INFO — More Information Needed:</strong> there is not enough information to make a judgment.</li>
              </ul>
            </div>
            <p>
              Copying, pasting, dragging, and the context menu are disabled. Please
              complete the task on your own without external tools.
            </p>
          </div>
          <label className="source-check-label" htmlFor="transfer-check">
            Which option best describes what you will do?
          </label>
          <p className="source-check-copy">
            An incorrect answer may be retried once. Two incorrect answers end this session.
          </p>
          <select
            id="transfer-check"
            className="source-check-select"
            value={comprehension}
            disabled={comprehensionSaving}
            onChange={(event) => handleComprehension(event.target.value)}
          >
            <option value="">Select one answer</option>
            <option value="classify-comments">Classify each comment by its political viewpoint</option>
            <option value={CORRECT_COMPREHENSION}>Read a post and comments, then give a judgment label and advice on a related but different post</option>
            <option value="copy-comments">Copy one of the comments as the advice response</option>
          </select>
          <p className="source-attempt-note">Incorrect answers recorded: {comprehensionAttempts} of 2</p>
          {comprehensionError && <p className="source-inline-error">{comprehensionError}</p>}
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("consent")}>Back to consent</SecondaryButton>
            <PrimaryButton disabled={comprehension !== CORRECT_COMPREHENSION || comprehensionSaving} onClick={beginExposure}>
              Begin Part 1
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "comprehension-failed") {
    return (
      <Page>
        <section className="source-panel source-error-panel">
          <p className="source-eyebrow">Session ended</p>
          <h2>This research session has ended after two incorrect answers.</h2>
          <p>
            The same participant ID cannot restart this study. Please return the
            study on Prolific if you entered through a Prolific listing.
          </p>
        </section>
      </Page>
    );
  }

  if (screen === "exposure") {
    return (
      <Page wide>
        <div className="source-task-heading transfer-task-heading">
          <div>
            <p className="source-eyebrow">Part 1 of 4</p>
            <h2>Read the discussion</h2>
          </div>
          <span>Read the post and all five comments at your own pace.</span>
        </div>
        <div className="source-stimulus-grid transfer-exposure-grid">
          <PostPanel eyebrow="Online discussion post" post={assignment.exposurePost} />
          <section className="source-panel source-comments-panel">
            <div className="source-comments-heading">
              <div>
                <p className="source-eyebrow">Anonymous responses</p>
                <h3>Comments on this post</h3>
              </div>
              <span>5 comments</span>
            </div>
            <p className="source-comments-instruction">Please read every comment before continuing.</p>
            <div className="source-comment-feed">
              {assignment.comments.map((comment, index) => (
                <article className="source-comment-card" key={assignment.commentHashes[index]}>
                  <div><span>{index + 1}</span></div>
                  <p>{comment}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
        <div className="source-submit-row transfer-submit-row">
          <p>You may return to the instructions now. After continuing to the second post, this discussion will no longer be available.</p>
          <div className="transfer-action-row transfer-inline-actions">
            <SecondaryButton onClick={() => returnToScreen("instructions")}>Back to instructions</SecondaryButton>
            <PrimaryButton onClick={continueToAdvice}>Continue to the second Reddit post</PrimaryButton>
          </div>
        </div>
      </Page>
    );
  }

  if (screen === "advice") {
    return (
      <Page wide>
        <div className="source-task-heading transfer-task-heading">
          <div>
            <p className="source-eyebrow">Part 2 of 4</p>
            <h2>Advise another Reddit user</h2>
          </div>
          <span>The earlier discussion is no longer available.</span>
        </div>
        <div className="transfer-advice-grid">
          <PostPanel eyebrow="The second Reddit post" post={assignment.targetPost} adviceTarget />
          <section className="source-panel transfer-response-panel">
            <p className="source-eyebrow">Your response</p>
            <h3>What advice would you give this Reddit user?</h3>
            <p>
              First, give one judgment label: YTA, NTA, ESH, NAH, or INFO. Then
              write what you genuinely think this Reddit user should do and explain
              your reasoning. Your response must contain at least {MIN_ADVICE_WORDS} English words.
            </p>
            <textarea
              className="transfer-textarea transfer-advice-textarea"
              value={advice}
              onChange={updateAdvice}
              onPaste={(event) => event.preventDefault()}
              onDrop={(event) => event.preventDefault()}
              placeholder="Begin with YTA, NTA, ESH, NAH, or INFO, then write your advice…"
              aria-describedby="advice-word-count"
            />
            <div
              id="advice-word-count"
              className={`transfer-word-count ${wordCount >= MIN_ADVICE_WORDS ? "complete" : ""}`}
            >
              <strong>{wordCount}</strong> / {MIN_ADVICE_WORDS} words minimum
            </div>
            <SaveStatus state={saveState} />
            <div className="transfer-action-row">
              <PrimaryButton disabled={wordCount < MIN_ADVICE_WORDS} onClick={continueToRatings}>
                Continue
              </PrimaryButton>
            </div>
          </section>
        </div>
      </Page>
    );
  }

  if (screen === "ratings") {
    return (
      <Page>
        <section className="source-panel source-rating-panel transfer-ratings-panel">
          <p className="source-eyebrow">Part 3 of 4</p>
          <h2>How did the advice task feel?</h2>
          <p className="transfer-section-copy">Please answer all three questions.</p>
          <ScaleQuestion
            legend="How difficult was it to decide what advice to give?"
            value={difficulty}
            onChange={setDifficulty}
            low="Not at all difficult"
            middle="Moderately difficult"
            high="Extremely difficult"
          />
          <ScaleQuestion
            legend="How effortful was it to decide what to say?"
            value={effort}
            onChange={setEffort}
            low="Not at all effortful"
            middle="Moderately effortful"
            high="Extremely effortful"
          />
          <ScaleQuestion
            legend="How confident are you that the advice you gave was right?"
            value={confidence}
            onChange={setConfidence}
            low="Not at all confident"
            middle="Moderately confident"
            high="Extremely confident"
          />
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("advice")}>Back to advice</SecondaryButton>
            <PrimaryButton
              disabled={[difficulty, effort, confidence].some((value) => value === null)}
              onClick={continueToPurpose}
            >
              Continue
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "funnel-purpose") {
    return (
      <Page>
        <section className="source-panel transfer-question-panel">
          <p className="source-eyebrow">Part 4 of 4 · Question 1 of 3</p>
          <h2>In your own words, what do you think this study was about?</h2>
          <textarea
            className="transfer-textarea"
            value={purposeGuess}
            onChange={(event) => setPurposeGuess(event.target.value)}
            onPaste={(event) => event.preventDefault()}
            placeholder="Enter your answer…"
          />
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("ratings")}>Back to ratings</SecondaryButton>
            <PrimaryButton disabled={!purposeGuess.trim()} onClick={continueToNotice}>Continue</PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "funnel-notice") {
    return (
      <Page>
        <section className="source-panel transfer-question-panel">
          <p className="source-eyebrow">Part 4 of 4 · Question 2 of 3</p>
          <h2>Did you notice anything unusual or noteworthy about the comments or where they may have come from?</h2>
          <ThreeWayChoice name="comments-stood-out" value={commentsStoodOut} onChange={setCommentsStoodOut} />
          <label className="transfer-optional-label" htmlFor="stood-out-details">
            If you would like, please explain. <span>Optional</span>
          </label>
          <textarea
            id="stood-out-details"
            className="transfer-textarea transfer-small-textarea"
            value={commentsStoodOutDetails}
            onChange={(event) => setCommentsStoodOutDetails(event.target.value)}
            onPaste={(event) => event.preventDefault()}
            placeholder="Optional explanation…"
          />
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("funnel-purpose")}>Back to previous question</SecondaryButton>
            <PrimaryButton disabled={!commentsStoodOut} onClick={continueToAi}>Continue</PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "funnel-ai") {
    return (
      <Page>
        <section className="source-panel transfer-question-panel">
          <p className="source-eyebrow">Part 4 of 4 · Question 3 of 3</p>
          <h2>Do you think the comments you read may have been generated by artificial intelligence?</h2>
          <ThreeWayChoice name="ai-generated-belief" value={aiGeneratedBelief} onChange={setAiGeneratedBelief} disabled={Boolean(pendingSubmissionRef.current)} />
          <div className="transfer-likelihood-block">
            <ScaleQuestion
              legend="How likely is it that the comments were generated by artificial intelligence (e.g. ChatGPT)?"
              value={aiLikelihood}
              onChange={setAiLikelihood}
              disabled={Boolean(pendingSubmissionRef.current)}
              low="Not at all likely"
              middle="Somewhat likely"
              high="Very likely"
            />
          </div>
          <SaveStatus state={saveState} />
          {submissionError && <p className="source-submission-error">{submissionError}</p>}
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("funnel-notice")}>Back to previous question</SecondaryButton>
            <PrimaryButton
              disabled={!aiGeneratedBelief || aiLikelihood === null || submissionState === "submitting"}
              onClick={submitStudy}
            >
              {submissionState === "submitting"
                ? "Saving…"
                : submissionState === "error"
                  ? "Retry submission"
                  : "Submit responses"}
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "debrief") {
    return (
      <Page>
        <section className="source-panel source-completion-panel transfer-debrief-panel">
          <div className="source-completion-mark" aria-hidden="true">✓</div>
          <p className="source-eyebrow">Response saved</p>
          <h2>Thank you. Your responses were saved successfully.</h2>
          <div className="transfer-debrief-copy">
            <h3>Debrief</h3>
            <p>
              This study examines whether reading an earlier set of opinions can
              influence the advice people later give in response to a different
              but related Reddit post. Some participants read comments written by people, while
              others read comments generated by artificial-intelligence systems.
              The study also examines how consistent the advice is across people,
              which considerations appear in their reasoning, and how difficult or
              confident the judgment feels.
            </p>
            <p>
              We did not explain the comment-source comparison before the task
              because knowing the full hypothesis could change how participants
              read the material. Please do not share these details with potential
              participants while data collection is underway.
            </p>
          </div>
          {assignment?.isTest ? (
            <PrimaryButton onClick={() => { setScreen("complete"); goTop(); }}>
              Finish test preview
            </PrimaryButton>
          ) : (
            <a className="source-primary-button transfer-completion-link" href={completion.url}>
              Complete study on Prolific
            </a>
          )}
        </section>
      </Page>
    );
  }

  return (
    <Page>
      <section className="source-panel source-completion-panel">
        <div className="source-completion-mark" aria-hidden="true">✓</div>
        <p className="source-eyebrow">Study complete</p>
        <h2>{assignment?.isTest ? "Test preview complete" : "Your study is complete"}</h2>
        <p>
          {alreadySubmitted
            ? "This participant ID already submitted a response. No duplicate response was created."
            : "Your saved response has been confirmed."}
        </p>
        {assignment?.isTest ? (
          <p className="source-completion-meta">
            This was a test session and does not occupy a formal study slot.
          </p>
        ) : completion.url ? (
          <a className="source-primary-button transfer-completion-link" href={completion.url}>
            Return to Prolific
          </a>
        ) : (
          <p className="source-completion-help">
            The formal completion code has not been configured. Please contact the research team.
          </p>
        )}
      </section>
    </Page>
  );
}
