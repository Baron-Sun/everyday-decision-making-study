import { admissionWait, jitterDelay, newComprehensionEvent, restoreComprehensionEvent, supabaseRpcWithRetry, supabaseRpcKeepalive } from "./advice-transfer-network.mjs";
export { supabaseRpcWithRetry } from "./advice-transfer-network.mjs";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ADVICE_TRANSFER_CONSENT_TEXT } from "./advice-transfer-consent";
import LegacyAdviceTransferTask from "./LegacyAdviceTransferTask.jsx";
import { CORRECT_COMPREHENSION, SCHEMA_VERSION, MIN_ADVICE_WORDS, MIN_GIST_WORDS, JUDGMENT_LABELS,
  POST_TASK_EFFORT, POST_TASK_OPINION_DIFFICULTY,
  DRAFTABLE_SCREENS, countEnglishWords, judgmentsFor, labelsFromJudgments,
  demographicsComplete, emptyDemographics, normalizeDemographics,
  phase1Complete, phase2Complete, restoreV4Draft, scaleValue } from "./advice-transfer-protocol.mjs";
import { useAdviceTransferTiming } from "./useAdviceTransferTiming.js";
import { ensureSharedReviewParticipant } from "./advice-transfer-review-entry.mjs";
export { MIN_ADVICE_WORDS, MIN_GIST_WORDS, countEnglishWords } from "./advice-transfer-protocol.mjs";

const HEARTBEAT_INTERVAL_MS = 30_000;
const DRAFT_SAVE_DELAY_MS = 1_500;
const SAME_POST_DESIGN = "same_post";
const SAME_POST_RESPONSE_GUIDANCE =
  "Now, imagine you are commenting on the same Reddit post. Write the opinion you would give to the user. The summary you wrote and the five comments you read in Phase 1 are shown below in case they are useful. First, give one judgment label: YTA, NTA, ESH, NAH, or INFO. Then write your opinion.";
const A_TO_B_RESPONSE_GUIDANCE =
  "Imagine you are commenting on this post in the online platform. Write the opinion you would give to the user. We have provided the comments you previously read in case this dilemma is similar. First, give one judgment label: YTA, NTA, ESH, NAH, or INFO. Then write your opinion.";
const CLAIM_RETRY_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 6_000];
const SUBMIT_RETRY_DELAYS_MS = [0, 750, 1_500, 3_000, 5_000];
const DEMOGRAPHIC_OPTIONS = Object.freeze({
  genderIdentity: [
    ["male", "Male"],
    ["female", "Female"],
    ["other", "Other"],
    ["prefer-not-to-say", "Prefer not to say"],
  ],
  englishProficiency: [
    ["yes", "Yes"],
    ["no-fluent", "No, but fluent"],
    ["no-mostly-fluent", "No, mostly fluent"],
    ["no-minimal-fluency", "No, minimal fluency"],
  ],
  educationLevel: [
    ["no-school", "No school"],
    ["eighth-grade-or-less", "Eighth grade or less"],
    ["more-than-eighth-less-than-high-school", "More than eighth grade, but less than high school degree"],
    ["high-school-degree-or-equivalent", "High school degree or equivalent"],
    ["some-college", "Some college"],
    ["four-year-college-degree", "4-year college degree"],
    ["graduate-or-professional-training", "Graduate or professional training"],
  ],
  employmentStatus: [
    ["employed", "Employed"],
    ["self-employed", "Self-employed"],
    ["student", "A student"],
    ["unemployed", "Unemployed"],
    ["other", "Other"],
  ],
});
const PROLIFIC_COMPLETION_BASE_URL =
  "https://app.prolific.com/submissions/complete";
const nowIso = () => new Date().toISOString();
const wait = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const storageKeyFor = ({ prolificPid, studyId, sessionId }) =>
  [
    "advice-transfer-v4-gist",
    prolificPid,
    studyId || "study",
    isTestParticipant(prolificPid) ? sessionId || "session" : "formal",
  ].join(":");

const readLocalDraft = (participant) => {
  for (const key of [storageKeyFor(participant)]) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch {
      // Server autosave remains available if this device backup cannot be read.
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
  for (const key of [storageKeyFor(participant)]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // A stale local backup is harmless because submitted sessions bypass it.
    }
  }
};

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
  if (!value?.assignmentId || !value?.exposurePost || !value?.targetPost || !value?.responsePost) {
    throw new Error("The assigned study material was incomplete.");
  }
  if (Object.prototype.hasOwnProperty.call(value, "condition")) {
    throw new Error("The assignment disclosed information that should remain masked.");
  }
  if (!["a_to_b", SAME_POST_DESIGN].includes(value.designVariant)) {
    throw new Error("The assigned study design was incomplete.");
  }
  if (![POST_TASK_EFFORT, POST_TASK_OPINION_DIFFICULTY].includes(value.postTaskMeasure)) {
    throw new Error("The assigned post-task measure was incomplete.");
  }
  if (
    value.exposurePost.postId === value.targetPost.postId ||
    !value.exposurePost.title ||
    !value.exposurePost.body ||
    !value.targetPost.title ||
    !value.targetPost.body ||
    !value.responsePost.title ||
    !value.responsePost.body
  ) {
    throw new Error("The assigned post pair failed its completeness check.");
  }
  for (const post of [value.exposurePost, value.targetPost, value.responsePost]) {
    if (!/^[a-f0-9]{64}$/i.test(String(post.sha256 || ""))) {
      throw new Error("An assigned post failed its audit-hash check.");
    }
  }
  const expectedResponsePost = value.designVariant === SAME_POST_DESIGN
    ? value.exposurePost
    : value.targetPost;
  if (
    value.responsePost.postId !== expectedResponsePost.postId ||
    value.responsePost.title !== expectedResponsePost.title ||
    value.responsePost.body !== expectedResponsePost.body ||
    value.responsePost.sha256 !== expectedResponsePost.sha256
  ) {
    throw new Error("The assigned response post did not match the study design.");
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

const SecondaryButton = ({ children, onClick, disabled = false }) => (
  <button type="button" className="source-secondary-button" disabled={disabled} onClick={onClick}>
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

const PostPanel = ({ eyebrow, post, adviceTarget = false, guidance = A_TO_B_RESPONSE_GUIDANCE }) => (
  <article className="source-panel source-post-panel transfer-post-panel">
    <div className="source-panel-heading">
      <p className="source-eyebrow">{eyebrow}</p>
      {adviceTarget && (
        <p className="transfer-advice-prompt">
          {guidance}
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
          value={optionValue}
          checked={value === optionValue}
          disabled={disabled}
          onChange={() => onChange(optionValue)}
        />
        {label}
      </label>
    ))}
  </div>
);

const DemographicChoice = ({ legend, name, options, value, onChange, disabled = false }) => (
  <fieldset className="transfer-demographic-fieldset" disabled={disabled}>
    <legend>{legend}</legend>
    <div className="transfer-demographic-options">
      {options.map(([optionValue, label]) => (
        <label
          key={optionValue}
          className={`transfer-demographic-option ${value === optionValue ? "selected" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={optionValue}
            checked={value === optionValue}
            onChange={() => onChange(optionValue)}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  </fieldset>
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

const LockedNotice = ({ children }) => (
  <p className="transfer-locked-notice" role="status">{children}</p>
);

const CommentFeed = ({ assignment, labels, onLabel, disabled = false }) => (
  <div className="source-comment-feed">
    {assignment.comments.map((comment, index) => (
      <article className="source-comment-card transfer-comment-card" key={`${index}-${assignment.commentHashes[index]}`}>
        <div className="transfer-comment-number"><span>{index + 1}</span></div>
        <p className="transfer-comment-text">{comment}</p>
        {labels && (
          <fieldset className="transfer-comment-classification" disabled={disabled}>
            <legend>Which label does Comment {index + 1} express?</legend>
            <div className="transfer-label-options">
              {JUDGMENT_LABELS.map((label) => (
                <label className={`transfer-label-option ${labels[index] === label ? "selected" : ""}`} key={label}>
                  <input type="radio" name={`comment-label-${index}`} value={label}
                    checked={labels[index] === label} onChange={() => onLabel(index, label)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </article>
    ))}
  </div>
);

const JudgmentLabelKey = () => (
  <aside className="transfer-label-key" aria-label="Judgment label key">
    <h4>Label key</h4>
    <dl>
      <div><dt>YTA</dt><dd><strong>You’re the Asshole:</strong> the commenter believes the poster is in the wrong.</dd></div>
      <div><dt>NTA</dt><dd><strong>Not the Asshole:</strong> the commenter believes the poster is not in the wrong.</dd></div>
      <div><dt>ESH</dt><dd><strong>Everyone Sucks Here:</strong> the commenter believes both the poster and the other party are in the wrong.</dd></div>
      <div><dt>NAH</dt><dd><strong>No Assholes Here:</strong> the commenter believes no one is in the wrong.</dd></div>
      <div><dt>INFO</dt><dd><strong>More Information Needed:</strong> the commenter believes there is not enough information to make a judgment.</dd></div>
    </dl>
  </aside>
);

export default function AdviceTransferTask() {
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
  const [commentLabels, setCommentLabels] = useState(["", "", "", "", ""]);
  const [gistText, setGistText] = useState("");
  const [gistDifficulty, setGistDifficulty] = useState(null);
  const [advice, setAdvice] = useState("");
  const [effort, setEffort] = useState(null);
  const [opinionDifficulty, setOpinionDifficulty] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [purposeGuess, setPurposeGuess] = useState("");
  const [commentsStoodOut, setCommentsStoodOut] = useState("");
  const [commentsStoodOutDetails, setCommentsStoodOutDetails] = useState("");
  const [aiGeneratedBelief, setAiGeneratedBelief] = useState("");
  const [aiLikelihood, setAiLikelihood] = useState(null);
  const [demographics, setDemographics] = useState(emptyDemographics);
  const [timestamps, setTimestamps] = useState({});
  const [submissionState, setSubmissionState] = useState("idle");
  const [submissionError, setSubmissionError] = useState("");
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [waitingInfo, setWaitingInfo] = useState(null);
  const [phase1Snapshot, setPhase1Snapshot] = useState(null);
  const [phase1LockedAt, setPhase1LockedAt] = useState(null);
  const [phase2Snapshot, setPhase2Snapshot] = useState(null);
  const [phase2LockedAt, setPhase2LockedAt] = useState(null);
  const [pendingStage, setPendingStage] = useState(null);
  const [pendingSubmission, setPendingSubmission] = useState(null);
  const [stageSaveState, setStageSaveState] = useState("idle");
  const [stageSaveError, setStageSaveError] = useState("");
  const [gistFocused, setGistFocused] = useState(false);
  const stageInFlight = useRef(false);
  const finalInFlight = useRef(false);
  const pendingStageRef = useRef(null);
  const pendingSubmissionRef = useRef(null);
  const serverLocksRef = useRef({ phase1: null, phase2: null });
  const recoverSessionRef = useRef(null);
  const phase1ReadOnly = Boolean(phase1LockedAt || pendingStage?.stage === "phase1");
  const phase2ReadOnly = Boolean(phase2LockedAt || pendingStage?.stage === "phase2");
  const saveInProgress = stageSaveState === "saving" || submissionState === "submitting";
  const timing = useAdviceTransferTiming({
    screen, phase1Locked: Boolean(phase1LockedAt), phase2Locked: Boolean(phase2LockedAt),
    pending: Boolean(pendingStage || pendingSubmission), gistFocused,
  });
  const completion = useMemo(() => getCompletion(), []);
  const wordCount = useMemo(() => countEnglishWords(advice), [advice]);
  const gistWordCount = useMemo(() => countEnglishWords(gistText), [gistText]);
  const isSamePostDesign = assignment?.designVariant === SAME_POST_DESIGN;
  const isOpinionDifficultyMeasure =
    assignment?.postTaskMeasure === POST_TASK_OPINION_DIFFICULTY;
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
      commentJudgments: judgmentsFor(assignment, commentLabels),
      gistText,
      gistDifficulty,
      advice,
      postTaskMeasure: assignment.postTaskMeasure,
      difficulty: isOpinionDifficultyMeasure ? opinionDifficulty : null,
      effort: isOpinionDifficultyMeasure ? null : effort,
      opinionDifficulty,
      confidence,
      purposeGuess,
      commentsStoodOut,
      commentsStoodOutDetails,
      aiGeneratedBelief,
      aiLikelihood,
      demographics,
      timestamps,
      timings: { ...timestamps },
      phase1Snapshot,
      phase1LockedAt,
      phase2Snapshot,
      phase2LockedAt,
      pendingStage,
      pendingSubmission,
    };
  }, [
    assignment?.assignmentId,
    screen,
    agreed,
    comprehension,
    comprehensionSaving,
    commentLabels,
    gistText,
    gistDifficulty,
    advice,
    effort,
    opinionDifficulty,
    isOpinionDifficultyMeasure,
    confidence,
    purposeGuess,
    commentsStoodOut,
    commentsStoodOutDetails,
    aiGeneratedBelief,
    aiLikelihood,
    demographics,
    timestamps,
    phase1Snapshot, phase1LockedAt, phase2Snapshot, phase2LockedAt,
    pendingStage, pendingSubmission,
  ]);

  const freshDraft = (draft = draftPayload) => draft ? {
    ...draft,
    savedAt: nowIso(),
    timings: { ...draft.timings, ...timing.read() },
    pendingStage: pendingStageRef.current,
    pendingSubmission: pendingSubmissionRef.current,
    pendingComprehension: pendingComprehensionRef.current,
  } : null;

  const applyServerSnapshots = (response, currentAssignment = assignment) => {
    if (response.phase1Snapshot && response.phase1LockedAt && response.phase1LockedAt !== serverLocksRef.current.phase1) {
      serverLocksRef.current.phase1 = response.phase1LockedAt;
      const saved = response.phase1Snapshot;
      setPhase1Snapshot(saved);
      setPhase1LockedAt(response.phase1LockedAt);
      setCommentLabels(labelsFromJudgments(currentAssignment, saved.commentJudgments));
      setGistText(saved.gistText);
      setGistDifficulty(saved.gistDifficulty);
      setTimestamps((current) => ({ ...current, ...saved.timings, phase1LockedAt: response.phase1LockedAt }));
      timing.restore({ ...timing.read(), phase1ActiveTimeMs: saved.timings.phase1ActiveTimeMs, gistActiveTimeMs: saved.timings.gistActiveTimeMs });
    }
    if (response.phase2Snapshot && response.phase2LockedAt && response.phase2LockedAt !== serverLocksRef.current.phase2) {
      serverLocksRef.current.phase2 = response.phase2LockedAt;
      const saved = response.phase2Snapshot;
      setPhase2Snapshot(saved);
      setPhase2LockedAt(response.phase2LockedAt);
      setAdvice(saved.adviceText);
      setEffort(saved.effort);
      setOpinionDifficulty(saved.difficulty);
      setConfidence(saved.confidence);
      setTimestamps((current) => ({ ...current, ...saved.timings, phase2LockedAt: response.phase2LockedAt }));
      timing.restore({ ...timing.read(), adviceResponseTimeMs: saved.timings.adviceResponseTimeMs });
    }
  };

  const recoverSession = () => {
    if (assignment && draftPayload) writeLocalDraft(assignment.participant, freshDraft());
    timing.pause();
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
    ensureSharedReviewParticipant();
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
            "claim_advice_transfer_assignment_same_post",
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
        if ((response.schemaVersion || response.protocolVersion) !== SCHEMA_VERSION) {
          // An existing v3 participant finishes the original task and pending
          // submission; never silently convert an old draft into a v4 response.
          setScreen("legacy");
          return;
        }
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
          const localDraft = readLocalDraft(participant);
          const restored = restoreV4Draft(response, [response.draftPayload, localDraft]);
          pendingComprehensionRef.current = restoreComprehensionEvent(response.assignmentId, [localDraft, response.draftPayload]);
          if (pendingComprehensionRef.current) setComprehensionError("Reconnecting to confirm your previous answer.");
          setAgreed(restored.agreed);
          setComprehension(restored.comprehension);
          setCommentLabels(labelsFromJudgments(response, restored.commentJudgments));
          setGistText(restored.gistText);
          setGistDifficulty(restored.gistDifficulty);
          setAdvice(restored.advice);
          setEffort(restored.effort);
          setOpinionDifficulty(restored.opinionDifficulty);
          setConfidence(restored.confidence);
          setPurposeGuess(String(restored.purposeGuess || ""));
          setCommentsStoodOut(["yes", "no", "unsure"].includes(restored.commentsStoodOut) ? restored.commentsStoodOut : "");
          setCommentsStoodOutDetails(String(restored.commentsStoodOutDetails || ""));
          setAiGeneratedBelief(["yes", "no", "unsure"].includes(restored.aiGeneratedBelief) ? restored.aiGeneratedBelief : "");
          setAiLikelihood(scaleValue(restored.aiLikelihood));
          setDemographics(normalizeDemographics(restored.demographics));
          setTimestamps(restored.timestamps);
          timing.restore(restored.timings);
          setPhase1Snapshot(restored.phase1Snapshot);
          setPhase1LockedAt(restored.phase1LockedAt);
          setPhase2Snapshot(restored.phase2Snapshot);
          setPhase2LockedAt(restored.phase2LockedAt);
          serverLocksRef.current = { phase1: restored.phase1LockedAt, phase2: restored.phase2LockedAt };
          pendingStageRef.current = restored.pendingStage;
          setPendingStage(restored.pendingStage);
          pendingSubmissionRef.current = restored.pendingSubmission;
          setPendingSubmission(restored.pendingSubmission);
          if (restored.pendingStage) {
            setStageSaveState("error");
            setStageSaveError("Your answers were recovered. Reconnecting to confirm the saved stage; you can also select Retry save.");
          }
          if (restored.pendingSubmission) {
            setSubmissionState("error");
            setSubmissionError("Your responses were recovered. Reconnecting to confirm submission; you can also select Retry submission.");
          }
          setScreen(restored.screen);
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
        const currentDraft = freshDraft();
        const result = await supabaseRpcWithRetry(
          assignment.config,
          "save_advice_transfer_draft",
          {
            p_assignment_id: assignment.assignmentId,
            p_prolific_pid: assignment.participant.prolificPid,
            p_payload: currentDraft,
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
          recoverSession();
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
        applyServerSnapshots(result);
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

  useEffect(() => {
    if (saveState !== "saved") return undefined;
    const timeoutId = window.setTimeout(() => setSaveState("idle"), 2_000);
    return () => window.clearTimeout(timeoutId);
  }, [saveState]);

  const goTop = () => window.scrollTo({ top: 0, behavior: "auto" });

  const returnToScreen = (previousScreen) => {
    if (saveInProgress || pendingStage || pendingSubmission || comprehensionSaving) return;
    timing.pause();
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
      consentedAt: current.consentedAt || time,
      instructionsOpenedAt: current.instructionsOpenedAt || time,
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
    if (!assignment || assignment.status !== "claimed" || !selectedOption || comprehensionInFlight.current || phase1ReadOnly) return;
    if (selectedOption === CORRECT_COMPREHENSION && !pendingComprehensionRef.current) {
      setComprehension(selectedOption);
      setComprehensionError("");
      setTimestamps((current) => ({ ...current, comprehensionPassedAt: current.comprehensionPassedAt || nowIso() }));
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

  const showPhase2Instructions = () => {
    if (comprehension !== CORRECT_COMPREHENSION || comprehensionSaving) return;
    setScreen("phase2-instructions");
    goTop();
  };

  const beginExposure = () => {
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      exposureOpenedAt: current.exposureOpenedAt || time,
    }));
    setScreen("exposure");
    goTop();
  };

  const saveStage = async (intent) => {
    if (!assignment || !intent || stageInFlight.current) return;
    stageInFlight.current = true;
    timing.pause();
    pendingStageRef.current = intent;
    setPendingStage(intent);
    setStageSaveState("saving");
    setStageSaveError("");
    writeLocalDraft(assignment.participant, { ...freshDraft(), pendingStage: intent });
    try {
      const result = await supabaseRpcWithRetry(assignment.config, "save_advice_transfer_stage", {
        p_assignment_id: assignment.assignmentId,
        p_prolific_pid: assignment.participant.prolificPid,
        p_stage: intent.stage,
        p_payload: intent.payload,
      });
      if (!result.ok || !result.snapshot || !result.lockedAt) throw new Error("The saved stage could not yet be confirmed.");
      applyServerSnapshots(result);
      pendingStageRef.current = null;
      setPendingStage(null);
      setStageSaveState("idle");
      setSaveState("idle");
      const nextScreen = intent.stage === "phase1" ? "advice" : "funnel-purpose";
      const nextTime = nowIso();
      const nextTimestamps = { ...timestamps, ...result.snapshot.timings,
        ...(intent.stage === "phase1"
          ? { exposureCompletedAt: result.lockedAt, phase1LockedAt: result.lockedAt, targetOpenedAt: timestamps.targetOpenedAt || nextTime }
          : { ratingsCompletedAt: result.lockedAt, phase2LockedAt: result.lockedAt, funnelPurposeOpenedAt: timestamps.funnelPurposeOpenedAt || nextTime }) };
      setTimestamps(nextTimestamps);
      // Persist the receipt immediately, before any navigation/refresh can occur.
      writeLocalDraft(assignment.participant, { ...freshDraft(), ...result,
        schemaVersion: SCHEMA_VERSION, screen: nextScreen, timestamps: nextTimestamps,
        pendingStage: null, pendingSubmission: pendingSubmissionRef.current });
      setScreen(nextScreen);
      goTop();
    } catch (saveError) {
      setStageSaveState("error");
      setStageSaveError(`Your answers are saved on this device. Please keep this page open and select Retry save to confirm them. ${saveError.message || ""}`.trim());
    } finally {
      stageInFlight.current = false;
    }
  };

  const continueToAdvice = () => {
    if (pendingStageRef.current) { saveStage(pendingStageRef.current); return; }
    if (phase1LockedAt) { returnToScreen("advice"); return; }
    if (!phase1Complete(commentLabels, gistText, gistDifficulty)) return;
    const activeTimings = timing.pause();
    saveStage({ stage: "phase1", payload: {
      schemaVersion: SCHEMA_VERSION,
      commentJudgments: judgmentsFor(assignment, commentLabels),
      gistText: gistText.trim(), gistDifficulty,
      timings: { ...timestamps, exposureCompletedAt: nowIso(),
        phase1ActiveTimeMs: activeTimings.phase1ActiveTimeMs,
        gistActiveTimeMs: activeTimings.gistActiveTimeMs },
    } });
  };

  const updateCommentLabel = (index, label) => {
    if (phase1ReadOnly) return;
    setCommentLabels((current) => current.map((value, position) => position === index ? label : value));
    setTimestamps((current) => ({ ...current, firstClassificationAt: current.firstClassificationAt || nowIso(), lastClassificationAt: nowIso() }));
  };

  const updateGist = (event) => {
    if (phase1ReadOnly) return;
    const value = event.target.value;
    setGistText(value);
    const time = nowIso();
    setTimestamps((current) => ({ ...current, gistFirstInputAt: current.gistFirstInputAt || (value ? time : ""), gistLastEditAt: time }));
  };

  const updateAdvice = (event) => {
    if (phase2ReadOnly) return;
    const value = event.target.value;
    const time = nowIso();
    setSaveState("idle");
    setAdvice(value);
    setTimestamps((current) => ({
      ...current,
      firstInputAt: current.firstInputAt || (value ? time : ""),
      lastEditAt: time,
    }));
  };

  const updateConfidence = (value) => {
    setSaveState("idle");
    setConfidence(value);
  };

  const updateOpinionDifficulty = (value) => {
    setSaveState("idle");
    setOpinionDifficulty(value);
  };

  const updateEffort = (value) => {
    setSaveState("idle");
    setEffort(value);
  };

  const continueToRatings = () => {
    if (wordCount < MIN_ADVICE_WORDS) return;
    timing.pause();
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      adviceCompletedAt: time,
      ratingsOpenedAt: current.ratingsOpenedAt || time,
    }));
    setScreen("ratings");
    goTop();
  };

  const continueToPurpose = () => {
    if (pendingStageRef.current) { saveStage(pendingStageRef.current); return; }
    if (phase2LockedAt) { returnToScreen("funnel-purpose"); return; }
    if (!phase1LockedAt || !phase2Complete(
      advice,
      effort,
      confidence,
      opinionDifficulty,
      assignment.postTaskMeasure,
    )) return;
    const activeTimings = timing.pause();
    saveStage({ stage: "phase2", payload: {
      schemaVersion: SCHEMA_VERSION,
      postTaskMeasure: assignment.postTaskMeasure,
      adviceText: advice.trim(),
      difficulty: isOpinionDifficultyMeasure ? opinionDifficulty : null,
      effort: isOpinionDifficultyMeasure ? null : effort,
      confidence,
      timings: { ...timestamps, ratingsCompletedAt: nowIso(), adviceResponseTimeMs: activeTimings.adviceResponseTimeMs },
    } });
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

  const continueToDemographics = () => {
    if (!aiGeneratedBelief || aiLikelihood === null || pendingSubmission) return;
    const time = nowIso();
    setTimestamps((current) => ({
      ...current,
      funnelAiCompletedAt: time,
      demographicsOpenedAt: current.demographicsOpenedAt || time,
    }));
    setScreen("demographics");
    goTop();
  };

  const updateDemographic = (key, value) => {
    if (pendingSubmission) return;
    setDemographics((current) => ({ ...current, [key]: value }));
  };

  const submitStudy = async () => {
    if (
      !assignment ||
      !phase1LockedAt || !phase2LockedAt ||
      !phase1Complete(commentLabels, gistText, gistDifficulty) ||
      !phase2Complete(
        advice,
        effort,
        confidence,
        opinionDifficulty,
        assignment.postTaskMeasure,
      ) ||
      !purposeGuess.trim() ||
      !commentsStoodOut ||
      !aiGeneratedBelief ||
      aiLikelihood === null ||
      !demographicsComplete(demographics) ||
      finalInFlight.current
    ) {
      return;
    }
    finalInFlight.current = true;
    timing.pause();
    setSubmissionState("submitting");
    setSubmissionError("");
    const submittedAt = nowIso();
    const finalTimestamps = pendingSubmissionRef.current?.timings || {
      ...timestamps,
      ...phase1Snapshot.timings,
      ...phase2Snapshot.timings,
      phase1LockedAt,
      phase2LockedAt,
      demographicsCompletedAt: submittedAt,
      clientSubmittedAt: submittedAt,
      exposureTimeMs: phase1Snapshot.timings.phase1ActiveTimeMs,
      phase1ActiveTimeMs: phase1Snapshot.timings.phase1ActiveTimeMs,
      gistActiveTimeMs: phase1Snapshot.timings.gistActiveTimeMs,
      adviceResponseTimeMs: phase2Snapshot.timings.adviceResponseTimeMs,
      totalStudyTimeMs: elapsedMs(timestamps.studyStartedAt, submittedAt),
    };

    const payload = pendingSubmissionRef.current || {
      schemaVersion: SCHEMA_VERSION,
      assignmentId: assignment.assignmentId,
      participant: assignment.participant,
      adviceText: advice.trim(),
      adviceWordCount: wordCount,
      adviceCharacterCount: advice.trim().length,
      postTaskMeasure: assignment.postTaskMeasure,
      difficulty: isOpinionDifficultyMeasure ? opinionDifficulty : null,
      commentJudgments: phase1Snapshot.commentJudgments,
      gistText: phase1Snapshot.gistText,
      gistDifficulty: phase1Snapshot.gistDifficulty,
      phase1LockedAt,
      phase2LockedAt,
      effort: isOpinionDifficultyMeasure ? null : effort,
      confidence,
      purposeGuess: purposeGuess.trim(),
      commentsStoodOut,
      commentsStoodOutDetails: commentsStoodOutDetails.trim(),
      aiGeneratedBelief,
      aiLikelihood,
      demographics: normalizeDemographics(demographics),
      timings: finalTimestamps,
      clientAudit: {
        pairNumber: assignment.pairNumber,
        pairRole: assignment.pairRole,
        exposurePostId: assignment.exposurePost.postId,
        exposurePostSha256: assignment.exposurePost.sha256,
        targetPostId: assignment.targetPost.postId,
        targetPostSha256: assignment.targetPost.sha256,
        designVariant: assignment.designVariant,
        postTaskMeasure: assignment.postTaskMeasure,
        responsePostId: assignment.responsePost.postId,
        responsePostSha256: assignment.responsePost.sha256,
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
    setPendingSubmission(payload);
    writeLocalDraft(assignment.participant, {
      ...(freshDraft() || {}),
      assignmentId: assignment.assignmentId,
      savedAt: submittedAt,
      screen: "demographics",
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
      setPendingSubmission(null);
      clearLocalDraft(assignment.participant);
      setTimestamps(finalTimestamps);
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
    if (!draftReady || stageSaveState !== "error" || !pendingStage || !assignment) return undefined;
    const retry = () => {
      if (navigator.onLine && document.visibilityState === "visible") saveStage(pendingStageRef.current);
    };
    const timeout = window.setTimeout(retry, jitterDelay(8_000));
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [draftReady, stageSaveState, pendingStage, assignment?.assignmentId]);

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

  if (screen === "legacy") return <LegacyAdviceTransferTask />;

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
          <h2>Read an online discussion and give your opinion</h2>
          <p className="source-intro-copy">
            In this task, you will read a public online post from the social media
            platform Reddit. These posts come from a Reddit group where people post
            about a social dilemma they are facing, and ask for people’s opinions.
            You will read the post and you will also see comments that offer
            opinions. Then, you will also offer your own opinion about {isSamePostDesign ? "the same dilemma" : "a similar dilemma"}.
          </p>
          <div className="source-overview-grid transfer-overview-time">
            <div><span>Estimated time</span><strong>About 10–12 minutes</strong></div>
          </div>
          <div className="source-intro-action">
            <div>
              <h3>Ready to review the consent form?</h3>
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
                disabled={phase1ReadOnly}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>
                I am at least 18 years old, I have read the consent information,
                and I voluntarily agree to participate.
              </span>
            </label>
            <div className="source-button-row">
              {!phase1LockedAt && <SecondaryButton onClick={declineConsent}>I Disagree</SecondaryButton>}
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
          <p className="source-eyebrow">Phase 1 instructions</p>
          <h2>Please read these instructions carefully</h2>
          <div className="source-instructions-copy transfer-instructions">
            <p>
              This survey has two phases. In Phase 1, you will read a Reddit post
              describing a dilemma and asking for opinions from others. You will
              also see five comments responding to the dilemma.
            </p>
            <p>
              We will then ask you to choose the label that each commenter expresses,
              following the conventions of the Reddit group called “Am I the Asshole”
              (see blue box below).
            </p>
            <div className="transfer-community-guidance">
              <h3>r/AmItheAsshole community guidance</h3>
              <p>
                <strong>AITA</strong> means “Am I the Asshole?” The judgment labels used
                in this community are:
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
              For each of the 5 comments you see, you will read the full comment and
              then classify the conclusion stated in it, using the categories above in
              the blue box. An explicit judgment abbreviation at the beginning of
              each displayed comment has been removed. Any judgment abbreviation that
              appears later in the comment remains unchanged. Choose the category that
              best matches the commenter’s overall conclusion. If a comment is nuanced
              or discusses more than one possible judgment, classify its final or main
              conclusion.
            </p>
            <p>Please classify each comment carefully based on the conclusion expressed by the commenter.</p>
            <p>Finally, you will summarize the gist of all 5 comments you read in your own words.</p>
            <p>
              Copying, pasting, dragging, and the context menu are disabled. Please
              complete the task on your own without external tools.
            </p>
          </div>
          <label className="source-check-label transfer-phase1-check-label" htmlFor="transfer-check">
            Which option describes what you will do in Phase 1?
          </label>
          <p className="source-check-copy">
            An incorrect answer may be retried once. Two incorrect answers end this session.
          </p>
          <select
            id="transfer-check"
            className="source-check-select"
            value={comprehension}
            disabled={comprehensionSaving || phase1ReadOnly}
            onChange={(event) => handleComprehension(event.target.value)}
          >
            <option value="">Select one answer</option>
            <option value="youtube-opinions">I will read Youtube comments and rate the opinions of these users and provide a summary</option>
            <option value={CORRECT_COMPREHENSION}>I will read Reddit comments about dilemmas, label opinions and summarize them</option>
            <option value="youtube-images">I will read Youtube comments and decide which images are depicted in them most frequently</option>
            <option value="reddit-memes">I will read Reddit comments about memes that are going viral and decide which ones are offensive.</option>
          </select>
          <p className="source-attempt-note">Incorrect answers recorded: {comprehensionAttempts} of 2</p>
          {comprehensionError && <p className="source-inline-error">{comprehensionError}</p>}
          <div className="transfer-action-row">
            <SecondaryButton disabled={comprehensionSaving} onClick={() => returnToScreen("consent")}>Back to consent</SecondaryButton>
            <PrimaryButton disabled={comprehension !== CORRECT_COMPREHENSION || comprehensionSaving} onClick={showPhase2Instructions}>
              Next
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "phase2-instructions") {
    return (
      <Page>
        <section className="source-panel source-intro-panel">
          <p className="source-eyebrow">Phase 2 instructions</p>
          <h2>Provide your opinion</h2>
          <div className="source-instructions-copy transfer-instructions">
            {isSamePostDesign ? (
              <p>
                In Phase 2, you will return to the same Reddit post and give your
                own opinion as if you were commenting on the social media platform.
                Your Phase 1 summary and the five comments will remain available
                for reference.
              </p>
            ) : (
              <p>
                For Phase 2, you will see another dilemma posted by a Reddit user.
                For this one, you will give your opinion as if you were commenting
                on the social media platform. You will be able to see the comments
                from the first dilemma in case the dilemma is similar and the
                opinions are relevant.
              </p>
            )}
          </div>
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("instructions")}>Back to Phase 1 instructions</SecondaryButton>
            <PrimaryButton onClick={beginExposure}>Press next to begin Phase 1</PrimaryButton>
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
            <p className="source-eyebrow">Phase 1</p>
            <h2>Read the discussion</h2>
          </div>
          <span>Read the post and all five comments at your own pace.</span>
        </div>
        {phase1LockedAt && <LockedNotice>Your Phase 1 answers have been saved and are read-only. You may review them here.</LockedNotice>}
        <div className="source-stimulus-grid transfer-exposure-grid">
          <PostPanel eyebrow="Online discussion post" post={assignment.exposurePost} />
          <section className="source-panel source-comments-panel">
            <div className="source-comments-heading">
              <div>
                <h3>Comments on this post</h3>
              </div>
              <span>5 comments</span>
            </div>
            <p className="source-comments-instruction">Please read every comment and choose the label it expresses.</p>
            <JudgmentLabelKey />
            <CommentFeed assignment={assignment} labels={commentLabels} onLabel={updateCommentLabel} disabled={phase1ReadOnly} />
          </section>
        </div>
        <section className="source-panel transfer-gist-panel source-rating-panel"
          onFocus={() => {
            if (!phase1ReadOnly) {
              setGistFocused(true);
              setTimestamps((current) => ({ ...current, gistOpenedAt: current.gistOpenedAt || nowIso() }));
            }
          }}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setGistFocused(false); }}>
          <label className="transfer-gist-label" htmlFor="comments-gist">Please provide, in your own words, a summary that captures the ‘gist’ of all the comments you read above.</label>
          <textarea id="comments-gist" className="transfer-textarea" value={gistText}
            readOnly={phase1ReadOnly} onChange={updateGist} placeholder="Write your summary here…"
            aria-describedby="gist-word-count" />
          <div id="gist-word-count" className={`transfer-word-count ${gistWordCount >= MIN_GIST_WORDS ? "complete" : ""}`}>
            <strong>{gistWordCount}</strong> / {MIN_GIST_WORDS} words minimum
          </div>
          <ScaleQuestion legend="How difficult was it to come up with the gist of all the comments?"
            value={gistDifficulty} onChange={setGistDifficulty} disabled={phase1ReadOnly}
            low="not at all difficult" middle="somewhat difficult" high="very difficult" />
          <SaveStatus
            state={
              saveState === "offline" ||
              commentLabels.some(Boolean) ||
              gistText.trim() ||
              gistDifficulty !== null
                ? saveState
                : "idle"
            }
          />
        </section>
        {stageSaveError && <p className="source-submission-error" role="alert">{stageSaveError}</p>}
        <div className="source-submit-row transfer-submit-row">
          <p>{phase1LockedAt ? "Your saved Phase 1 answers cannot be changed." : "When you continue, your Phase 1 answers will be saved and locked. The comments will remain available in Phase 2."}</p>
          <div className="transfer-action-row transfer-inline-actions">
            <SecondaryButton disabled={Boolean(pendingStage)} onClick={() => returnToScreen("phase2-instructions")}>Back to instructions</SecondaryButton>
            <PrimaryButton disabled={stageSaveState === "saving" || !phase1Complete(commentLabels, gistText, gistDifficulty)} onClick={continueToAdvice}>
              {stageSaveState === "saving" ? "Saving…" : stageSaveState === "error" ? "Retry save" : "Continue to Phase 2"}
            </PrimaryButton>
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
            <p className="source-eyebrow">Phase 2</p>
            <h2>Provide your opinion</h2>
          </div>
        </div>
        {phase2LockedAt && <LockedNotice>Your opinion and post-task ratings have been saved and are read-only.</LockedNotice>}
        <div className="transfer-advice-grid">
          <div className="transfer-reference-column">
            <PostPanel
              eyebrow={isSamePostDesign ? "The Reddit post" : "The second Reddit post"}
              post={assignment.responsePost}
              adviceTarget
              guidance={isSamePostDesign ? SAME_POST_RESPONSE_GUIDANCE : A_TO_B_RESPONSE_GUIDANCE}
            />
            {isSamePostDesign && (
              <section className="source-panel transfer-previous-gist" aria-label="Your Phase 1 summary">
                <h3>Your summary from Phase 1</h3>
                <p>{phase1Snapshot?.gistText || gistText}</p>
              </section>
            )}
            <section className="source-panel source-comments-panel transfer-previous-comments">
              <h3>{isSamePostDesign
                ? "Here are the comments you read in Phase 1 in case they are useful."
                : "Here are the comments for the previous post in case they are useful for this post"}</h3>
              <CommentFeed assignment={assignment} />
            </section>
          </div>
          <section className="source-panel transfer-response-panel">
            <label className="transfer-response-label" htmlFor="opinion-response">Your response</label>
            <textarea
              id="opinion-response"
              className="transfer-textarea transfer-advice-textarea"
              value={advice}
              readOnly={phase2ReadOnly}
              onChange={updateAdvice}
              onPaste={(event) => event.preventDefault()}
              onDrop={(event) => event.preventDefault()}
              placeholder="Begin with YTA, NTA, ESH, NAH, or INFO, then write your opinion…"
              aria-describedby="advice-word-count"
            />
            <div
              id="advice-word-count"
              className={`transfer-word-count ${wordCount >= MIN_ADVICE_WORDS ? "complete" : ""}`}
            >
              <strong>{wordCount}</strong> / {MIN_ADVICE_WORDS} words minimum
            </div>
            <SaveStatus state={saveState === "offline" || advice.trim() ? saveState : "idle"} />
            <div className="transfer-action-row">
              <SecondaryButton onClick={() => returnToScreen("exposure")}>Back to Phase 1</SecondaryButton>
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
          <p className="source-eyebrow">After Phase 2</p>
          <h2>Post-task survey</h2>
          <p className="transfer-section-copy">Please answer both questions.</p>
          {phase2LockedAt && <LockedNotice>Your opinion and ratings have been saved and are read-only.</LockedNotice>}
          <ScaleQuestion
            legend="How confident are you that the opinion you gave was right?"
            value={confidence}
            onChange={updateConfidence}
            disabled={phase2ReadOnly}
            low="Not at all confident"
            middle="Moderately confident"
            high="Extremely confident"
          />
          {isOpinionDifficultyMeasure ? (
            <ScaleQuestion
              legend="How difficult was it to form your final opinion about the dilemma?"
              value={opinionDifficulty}
              onChange={updateOpinionDifficulty}
              disabled={phase2ReadOnly}
              low="Not at all difficult"
              middle="Moderately difficult"
              high="Extremely difficult"
            />
          ) : (
            <ScaleQuestion
              legend="How effortful was it to decide what to say?"
              value={effort}
              onChange={updateEffort}
              disabled={phase2ReadOnly}
              low="Not at all effortful"
              middle="Moderately effortful"
              high="Extremely effortful"
            />
          )}
          <SaveStatus
            state={
              saveState === "offline" ||
              confidence !== null ||
              (isOpinionDifficultyMeasure ? opinionDifficulty : effort) !== null
                ? saveState
                : "idle"
            }
          />
          {stageSaveError && <p className="source-submission-error" role="alert">{stageSaveError}</p>}
          <div className="transfer-action-row">
            <SecondaryButton disabled={Boolean(pendingStage)} onClick={() => returnToScreen("advice")}>Back to your opinion</SecondaryButton>
            <PrimaryButton
              disabled={stageSaveState === "saving" || !phase2Complete(
                advice,
                effort,
                confidence,
                opinionDifficulty,
                assignment.postTaskMeasure,
              )}
              onClick={continueToPurpose}
            >
              {stageSaveState === "saving" ? "Saving…" : stageSaveState === "error" ? "Retry save" : "Continue"}
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
          <p className="source-eyebrow">Part 4 of 5 · Question 1 of 3</p>
          <h2>In your own words, what do you think this study was about?</h2>
          <textarea
            className="transfer-textarea"
            value={purposeGuess}
            readOnly={Boolean(pendingSubmission)}
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
          <p className="source-eyebrow">Part 4 of 5 · Question 2 of 3</p>
          <h2>Did you notice anything unusual or noteworthy about the comments or where they may have come from?</h2>
          <ThreeWayChoice name="comments-stood-out" value={commentsStoodOut} onChange={setCommentsStoodOut} disabled={Boolean(pendingSubmission)} />
          <label className="transfer-optional-label" htmlFor="stood-out-details">
            If you would like, please explain. <span>Optional</span>
          </label>
          <textarea
            id="stood-out-details"
            className="transfer-textarea transfer-small-textarea"
            value={commentsStoodOutDetails}
            readOnly={Boolean(pendingSubmission)}
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
          <p className="source-eyebrow">Part 4 of 5 · Question 3 of 3</p>
          <h2>Do you think the comments you read may have been generated by artificial intelligence?</h2>
          <ThreeWayChoice name="ai-generated-belief" value={aiGeneratedBelief} onChange={setAiGeneratedBelief} disabled={Boolean(pendingSubmission)} />
          <div className="transfer-likelihood-block">
            <ScaleQuestion
              legend="How likely is it that the comments were generated by artificial intelligence (e.g. ChatGPT)?"
              value={aiLikelihood}
              onChange={setAiLikelihood}
              disabled={Boolean(pendingSubmission)}
              low="Not at all likely"
              middle="Somewhat likely"
              high="Very likely"
            />
          </div>
          <SaveStatus state={saveState} />
          <div className="transfer-action-row">
            <SecondaryButton onClick={() => returnToScreen("funnel-notice")}>Back to previous question</SecondaryButton>
            <PrimaryButton
              disabled={!aiGeneratedBelief || aiLikelihood === null}
              onClick={continueToDemographics}
            >
              Continue
            </PrimaryButton>
          </div>
        </section>
      </Page>
    );
  }

  if (screen === "demographics") {
    const demographicsLocked = Boolean(pendingSubmission);
    return (
      <Page>
        <section className="source-panel transfer-question-panel transfer-demographics-panel">
          <p className="source-eyebrow">Part 5 of 5</p>
          <h2>About you</h2>
          <p className="transfer-section-copy">
            To complete the task, please answer a few questions about yourself.
          </p>

          <DemographicChoice
            legend="With which gender identity do you mostly identify?"
            name="gender-identity"
            options={DEMOGRAPHIC_OPTIONS.genderIdentity}
            value={demographics.genderIdentity}
            onChange={(value) => updateDemographic("genderIdentity", value)}
            disabled={demographicsLocked}
          />

          <div className="transfer-demographic-fieldset transfer-age-field">
            <label htmlFor="participant-age">What is your age?</label>
            <input
              id="participant-age"
              type="number"
              min="18"
              max="120"
              step="1"
              inputMode="numeric"
              value={demographics.ageYears ?? ""}
              readOnly={demographicsLocked}
              onChange={(event) => updateDemographic(
                "ageYears",
                event.target.value === "" ? null : Number(event.target.value),
              )}
            />
          </div>

          <DemographicChoice
            legend="Is English your first language?"
            name="english-proficiency"
            options={DEMOGRAPHIC_OPTIONS.englishProficiency}
            value={demographics.englishProficiency}
            onChange={(value) => updateDemographic("englishProficiency", value)}
            disabled={demographicsLocked}
          />

          <DemographicChoice
            legend="Please indicate your education level"
            name="education-level"
            options={DEMOGRAPHIC_OPTIONS.educationLevel}
            value={demographics.educationLevel}
            onChange={(value) => updateDemographic("educationLevel", value)}
            disabled={demographicsLocked}
          />

          <DemographicChoice
            legend="Are you currently...?"
            name="employment-status"
            options={DEMOGRAPHIC_OPTIONS.employmentStatus}
            value={demographics.employmentStatus}
            onChange={(value) => updateDemographic("employmentStatus", value)}
            disabled={demographicsLocked}
          />

          <SaveStatus state={saveState} />
          {submissionError && <p className="source-submission-error">{submissionError}</p>}
          <div className="transfer-action-row">
            <SecondaryButton disabled={demographicsLocked} onClick={() => returnToScreen("funnel-ai")}>Back to previous question</SecondaryButton>
            <PrimaryButton
              disabled={!demographicsComplete(demographics) || submissionState === "submitting"}
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
              This study examines whether reading a set of opinions can influence
              the opinion people then give about {isSamePostDesign ? "the same Reddit post" : "a different but related Reddit post"}.
              Some participants read comments written by people, while
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
        <SecondaryButton onClick={() => { setScreen("debrief"); goTop(); }}>Review debrief</SecondaryButton>
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
