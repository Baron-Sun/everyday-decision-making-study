const DEFAULT_DELAYS = [0, 750, 1_500, 3_000, 5_000];
const BACKGROUND_METHODS = new Set([
  "save_advice_transfer_draft",
  "heartbeat_advice_transfer_assignment",
]);

// Equal jitter preserves a minimum delay while spreading a simultaneous wave
// of participants across the retry window.
export const jitterDelay = (milliseconds, random = Math.random) =>
  Math.round(milliseconds * (0.75 + random() * 0.5));

export const newComprehensionEvent = (selectedOption) => ({
  selectedOption,
  clientEventId: globalThis.crypto?.randomUUID?.()
    || `failure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  occurredAt: new Date().toISOString(),
});

export const restoreComprehensionEvent = (assignmentId, drafts) => {
  const draft = drafts.filter((candidate) => candidate?.assignmentId === assignmentId
    && Object.prototype.hasOwnProperty.call(candidate, "pendingComprehension"))
    .sort((a, b) => (Date.parse(b.savedAt) || 0) - (Date.parse(a.savedAt) || 0))[0];
  const event = draft?.pendingComprehension;
  if (typeof event?.clientEventId === "string" && event.clientEventId
      && typeof event.selectedOption === "string" && event.selectedOption) return event;
  return null;
};

export const admissionWait = (response, random = Math.random) => {
  if (!["waiting", "closed"].includes(response?.admissionStatus)) return null;
  const closed = response.admissionStatus === "closed";
  const reconnecting = response.reason === "server_busy";
  return {
    info: {
      queuePosition: !closed && !reconnecting ? Number(response.queuePosition) || 1 : null,
      waitedSeconds: Number(response.waitedSeconds) || 0,
      closed,
      reconnecting,
    },
    delay: jitterDelay(reconnecting
      ? Math.max(500, Math.min(1_500, Number(response.retryAfterMs) || 1_000))
      : Math.max(2_000, Math.min(15_000, Number(response.retryAfterMs) || (closed ? 10_000 : 3_000))), random),
  };
};

// A lane is local to one browser and one assignment. Backend locks still
// protect cross-tab and cross-participant concurrency.
export const createStudyTransport = ({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timers = globalThis,
  random = Math.random,
  timeoutMs = 12_000,
  sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)),
} = {}) => {
  const lanes = new Map();
  const keyFor = (config, payload) => JSON.stringify([
    config.url,
    payload.p_assignment_id || [payload.p_prolific_pid, payload.p_study_id, payload.p_session_id],
  ]);

  const rpc = async (config, method, payload) => {
    const controller = new AbortController();
    const timeout = timers.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let responseText;
    try {
      response = await fetchImpl(`${config.url}/rest/v1/rpc/${method}`, {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // A stalled or disconnected response body must also time out and retry.
      responseText = await response.text();
    } catch (cause) {
      const error = new Error(cause?.name === "AbortError"
        ? "The study database is taking longer than expected to respond."
        : "The study database could not be reached.");
      error.retryable = true;
      error.cause = cause;
      throw error;
    } finally {
      timers.clearTimeout(timeout);
    }
    let data = null;
    try { data = responseText ? JSON.parse(responseText) : null; } catch { /* retry below */ }
    if (!response.ok) {
      const error = new Error(data?.message || `The study database returned HTTP ${response.status}.`);
      error.status = response.status;
      error.code = data?.code || "";
      error.retryable = [408, 409, 425, 429].includes(response.status)
        || response.status >= 500
        || ["40001", "40P01", "55P03", "57014"].includes(error.code);
      const retryAfter = Number(response.headers?.get?.("Retry-After"));
      error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(30_000, retryAfter * 1_000) : 0;
      throw error;
    }
    if (data === null) {
      const error = new Error("The study database returned an incomplete response.");
      error.retryable = true;
      throw error;
    }
    return data;
  };

  const drain = async (key, lane) => {
    if (lane.running) return;
    lane.running = true;
    while (lane.queue.length) {
      lane.queue.sort((a, b) => a.priority - b.priority);
      const job = lane.queue.shift();
      try {
        let result;
        let lastError;
        for (let index = 0; index < job.delays.length; index += 1) {
          // Let a user-triggered stage/final save proceed after the current
          // background attempt, rather than waiting through its retry series.
          if (lastError && job.priority > 0 && lane.queue.some((next) => next.priority === 0)) break;
          const delay = Math.max(jitterDelay(job.delays[index], random), lastError?.retryAfterMs || 0);
          if (delay) await sleep(delay);
          try {
            result = await rpc(job.config, job.method, job.payload);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (!error.retryable) break;
          }
        }
        if (lastError) throw lastError;
        for (const waiter of job.waiters) waiter.resolve(result);
      } catch (error) {
        for (const waiter of job.waiters) waiter.reject(error);
      }
    }
    lane.running = false;
    if (lanes.get(key) === lane) lanes.delete(key);
  };

  const request = (config, method, payload, delays = DEFAULT_DELAYS) => {
    const key = keyFor(config, payload);
    let lane = lanes.get(key);
    if (!lane) { lane = { running: false, queue: [] }; lanes.set(key, lane); }
    return new Promise((resolve, reject) => {
      const background = BACKGROUND_METHODS.has(method);
      const queued = background ? lane.queue.find((job) => job.method === method) : null;
      if (queued) {
        // Keep the newest immutable payload; every queued caller receives the
        // receipt for that snapshot, without sending obsolete intermediate drafts.
        queued.payload = payload;
        queued.waiters.push({ resolve, reject });
      } else {
        lane.queue.push({ config, method, payload,
          delays: delays.length ? delays : [0], priority: background ? 1 : 0,
          waiters: [{ resolve, reject }] });
      }
      void drain(key, lane);
    });
  };

  const keepalive = (config, method, payload) => {
    // A live save renews the lease. Do not race it with a departure that would
    // shorten the lease; the caller has already made its local departure backup.
    if (lanes.has(keyFor(config, payload))) return;
    fetchImpl(`${config.url}/rest/v1/rpc/${method}`, {
      method: "POST", keepalive: true,
      headers: { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  };

  return { request, keepalive };
};

const transport = createStudyTransport();
export const supabaseRpc = (config, method, payload) => transport.request(config, method, payload, [0]);
export const supabaseRpcWithRetry = (config, method, payload, delays) => transport.request(config, method, payload, delays);
export const supabaseRpcKeepalive = (config, method, payload) => transport.keepalive(config, method, payload);
