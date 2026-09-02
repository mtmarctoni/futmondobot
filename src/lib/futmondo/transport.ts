import { FutmondoError } from "./errors";
import type { Envelope, Header } from "./types";

export const BASE_URL = process.env.FUTMONDO_API_URL ?? "https://api.futmondo.com";

/**
 * Minimum gap between calls. Clause discovery fans out one /1/player/summary per
 * player, which for a 14-team league is several hundred requests; the community
 * clients that survive long-term all serialise with a delay in this range.
 */
export const MIN_REQUEST_INTERVAL_MS = Number(
  process.env.FUTMONDO_MIN_INTERVAL_MS ?? 300,
);

/** Headers the Android app sends. Mimicked so our traffic looks ordinary. */
const APP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es-ES,es;q=0.9",
  Origin: "https://app.futmondo.com",
  Referer: "https://app.futmondo.com/",
  "X-Requested-With": "com.futmondo.app",
  "X-Device": "android",
};

/**
 * Serialises every outbound call through one promise chain with a minimum gap.
 * Module-level so concurrent route handlers in the same lambda share the budget.
 */
let queueTail: Promise<unknown> = Promise.resolve();
let lastSentAt = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = lastSentAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSentAt = Date.now();
    return job();
  });
  // Keep the chain alive even when a job rejects, so one failure cannot wedge
  // the queue for every later caller.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PostOptions {
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Sends one envelope and returns the unwrapped `answer`, throwing a
 * FutmondoError when the body reports an error. Callers get `answer` as-is:
 * some endpoints return a bare array, others an object wrapping one.
 */
export async function postEnvelope(
  endpoint: string,
  header: Header,
  query: Record<string, unknown>,
  opts: PostOptions = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const payload: Envelope = { header, query, answer: {} };

  return schedule(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await doFetch(`${BASE_URL}${endpoint}`, {
        method: "POST",
        headers: APP_HEADERS,
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FutmondoError(
        `Network error calling ${endpoint}: ${reason}`,
        undefined,
        endpoint,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* fall through to the checks below */
    }

    if (!res.ok) {
      throw new FutmondoError(
        `${endpoint} returned HTTP ${res.status}`,
        undefined,
        endpoint,
        res.status,
      );
    }

    if (!body || typeof body !== "object") {
      throw new FutmondoError(
        `${endpoint} returned a non-JSON body`,
        undefined,
        endpoint,
        res.status,
      );
    }

    const answer = (body as { answer?: unknown }).answer;
    if (answer === undefined) {
      throw new FutmondoError(
        `${endpoint} response had no answer field`,
        undefined,
        endpoint,
        res.status,
      );
    }

    // Failure arrives as HTTP 200 with answer.error true. This is the only
    // reliable signal — see docs/futmondo-api.md.
    if (answer && typeof answer === "object" && !Array.isArray(answer)) {
      const record = answer as Record<string, unknown>;
      if (record.error === true) {
        const code = typeof record.code === "string" ? record.code : undefined;
        throw new FutmondoError(
          `${endpoint} rejected: ${code ?? "unknown error"}`,
          code,
          endpoint,
          res.status,
        );
      }
    }

    return answer;
  });
}

/** Resets the shared throttle. Tests only. */
export function resetTransportQueue(): void {
  queueTail = Promise.resolve();
  lastSentAt = 0;
}
