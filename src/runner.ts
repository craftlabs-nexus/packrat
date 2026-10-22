/**
 * Run an import plan in two stages.
 *
 * `fetchRows` gets the selected rows' bytes (local Files, or downloads with
 * up to `downloadConcurrency` in flight or waiting), verifies their hashes
 * and yields them one at a time, in plan order. `runImport` feeds each one
 * to the caller's `extract` and `commit`, strictly one at a time (bounds
 * memory: one extraction plus a few downloaded Files). Both are cancellable
 * between rows; sources already committed stay.
 *
 * A download that fails to connect (CORS or offline: fetch's TypeError)
 * tries the file's altUrls, and trips a per-host breaker: the first row on
 * that host is reported failed, later rows on it are skipped ("host-blocked")
 * without another request. Any TypeError the download rejects with trips
 * it, so a `download` should reject with another error type for HTTP errors.
 * The rows already in the download window when the first one fails have
 * started their requests, so a blocked host costs up to
 * `downloadConcurrency` requests.
 *
 * Cancellation is the signal, not an error's name: once it has fired, a
 * failed download (whatever it rejected with) cancels its row.
 *
 * What a JAR is for is the caller's: Packrat reports what `commit` returns.
 */
import { getErrorMessage } from "./utils";
import {
  trySha512Hex,
  verifyWithWebCrypto,
  type ExpectedHashes,
  type HashCheck,
} from "./hashing";
import type { ImportMetadata, PackEntry, ReviewRow, SkipReason } from "./types";

/**
 * A row's progress. fetchRows reports queued, downloading, skipped, failed
 * and cancelled; runImport adds extracting and done.
 */
export type RowProgress =
  | { phase: "queued" }
  | { phase: "downloading"; percent: number }
  | { phase: "extracting" }
  /** counts: what commit returned (e.g. { items: 12, tags: 3 }) */
  | { phase: "done"; counts: Record<string, number> }
  | { phase: "skipped"; reason: string }
  | { phase: "failed"; error: string }
  | { phase: "cancelled" };

/** What fetchRows needs from the caller. */
export interface FetchDeps {
  download: (
    url: string,
    filename: string,
    options: { onProgress: (percent: number) => void; signal: AbortSignal },
  ) => Promise<File>;
  /**
   * Check the bytes against the hashes the pack lists (sha512, sha256,
   * sha1; only those it has). Default: {@link verifyWithWebCrypto}.
   */
  verify?: (buffer: ArrayBuffer, expected: ExpectedHashes) => Promise<HashCheck>;
  /**
   * The SHA-512 reported for a file when verify did not confirm the pack's
   * own (lowercase hex; undefined when hashing is unavailable).
   * Default: {@link trySha512Hex}.
   */
  sha512?: (buffer: ArrayBuffer) => Promise<string | undefined>;
}

/** What `commit` says about a JAR: the runner reports it as it is. */
export interface CommitResult {
  /** skipped: the caller found nothing to keep (reason: why, shown on the row) */
  status: "added" | "duplicate" | "skipped";
  reason?: string;
  /** What was added (summed into ImportSummary.counts), e.g. { items: 12, tags: 3 } */
  counts?: Record<string, number>;
}

export interface RunnerDeps<R = unknown> extends FetchDeps {
  extract: (buffer: ArrayBuffer, filename: string) => Promise<R>;
  commit: (result: R, metadata: ImportMetadata) => Promise<CommitResult>;
  /**
   * An extraction error that means the JAR has nothing to import (the row
   * is skipped as "no-items", not failed). Default: an error named
   * "JarValidationError" whose code is "NO_CONTENT".
   */
  isNoContent?: (e: unknown) => boolean;
}

/** Why a row was not imported (plan statuses plus run-time outcomes). */
export type SummarySkipReason =
  | SkipReason
  | "unresolvable"
  | "not-selected"
  /** detail: the host whose first download failed to connect */
  | "host-blocked"
  /** commit returned "skipped"; detail: its reason */
  | "commit-skipped";

export interface SkippedRow {
  key: string;
  filename: string;
  reason: SummarySkipReason;
  detail?: string;
}

export interface FailedRow {
  key: string;
  filename: string;
  error: string;
  /** Set when the download failed to connect (CORS or offline) */
  host?: string;
}

/** What fetchRows did with the rows it did not yield. */
export interface FetchSummary {
  skipped: SkippedRow[];
  failed: FailedRow[];
  /** Selected rows not run because the import was cancelled */
  notRun: number;
  cancelled: boolean;
}

export interface ImportSummary extends FetchSummary {
  imported: number;
  /** The sum of every commit's counts */
  counts: Record<string, number>;
}

export interface FetchOptions {
  signal: AbortSignal;
  downloadConcurrency?: number;
  /**
   * Last line of defence: a URL it refuses is never fetched (left out as if
   * the row did not list it; a row left with none fails). The plan already
   * drops blocked alternatives.
   */
  allowUrl?: (url: string) => boolean;
  /**
   * Fail a row whose file the pack lists a hash for when the runner could
   * not check it (verify said "unavailable"). Rows without any hash run.
   */
  requireHash?: boolean;
  onRow?: (key: string, progress: RowProgress) => void;
}

export interface RunOptions extends FetchOptions {
  packName?: string;
}

/** A selected row's bytes, as fetchRows yields them. */
export interface FetchedRow {
  row: ReviewRow;
  buffer: ArrayBuffer;
  /** The bytes matched every hash the pack lists for the file */
  hashVerified: boolean;
  /** The pack's sha512 when verified, else computed; absent when hashing is unavailable */
  sha512?: string;
}

/** fetchRows' result: iterate it once; `summary` is complete when the iteration ends. */
export type FetchRowsRun = AsyncGenerator<FetchedRow, void, undefined> & {
  readonly summary: FetchSummary;
};

export const DEFAULT_DOWNLOAD_CONCURRENCY = 3;

/** User-facing reason for a failed download. */
export function describeDownloadError(e: unknown): string {
  if (e instanceof TypeError) return "download blocked (CORS) or offline";
  return getErrorMessage(e);
}

function defaultIsNoContent(e: unknown): boolean {
  return (
    e instanceof Error &&
    e.name === "JarValidationError" &&
    (e as { code?: unknown }).code === "NO_CONTENT"
  );
}

type Fetched =
  | { ok: true; buffer: ArrayBuffer }
  /** hosts: every URL's host, when none of them could connect */
  | { ok: false; error: unknown; hosts?: string[] };

/** The hashes the entry lists, lowercase, without the absent ones. */
function expectedHashes(entry: PackEntry): ExpectedHashes {
  const expected: ExpectedHashes = {};
  for (const a of ["sha512", "sha256", "sha1"] as const) {
    if (entry[a]) expected[a] = entry[a].toLowerCase();
  }
  return expected;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const noProgress = () => {};

/**
 * Fetch and verify the selected rows, yielding each one's bytes in plan
 * order; rows that are not selected, cannot be fetched or fail their hash
 * are reported in `summary` (and to `onRow`) instead. The next rows are
 * downloaded while the caller handles a yielded one. Breaking out of the
 * loop aborts the downloads in flight; the rows not yet yielded are then
 * left out of the summary.
 */
export function fetchRows(
  rows: ReviewRow[],
  deps: FetchDeps,
  opts: FetchOptions,
): FetchRowsRun {
  const summary: FetchSummary = { skipped: [], failed: [], notRun: 0, cancelled: false };
  return Object.assign(fetchStage(rows, deps, opts, summary), { summary });
}

async function* fetchStage(
  rows: ReviewRow[],
  deps: FetchDeps,
  opts: FetchOptions,
  summary: FetchSummary,
): AsyncGenerator<FetchedRow, void, undefined> {
  const onRow = opts.onRow ?? noProgress;
  const concurrency = Math.max(
    1,
    opts.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
  );

  // Rows that won't run are reported as skipped with their plan status
  const toRun: ReviewRow[] = [];
  for (const row of rows) {
    const { entry, status } = row;
    const { key, filename } = entry;
    if (row.selected && entry.origin && status.kind !== "unresolvable") {
      toRun.push(row);
    } else if (status.kind === "unresolvable") {
      summary.skipped.push({ key, filename, reason: "unresolvable", detail: status.reason });
    } else if (status.kind === "skip") {
      summary.skipped.push({ key, filename, reason: status.reason, detail: status.detail });
    } else {
      summary.skipped.push({ key, filename, reason: "not-selected" });
    }
  }
  for (const row of toRun) onRow(row.entry.key, { phase: "queued" });

  // The downloads' signal: the caller's, or the end of the iteration
  const inner = new AbortController();
  const forward = () => inner.abort(opts.signal.reason);
  if (opts.signal.aborted) forward();
  else opts.signal.addEventListener("abort", forward, { once: true });
  const signal = inner.signal;

  // Per-host breaker: hosts with a connect failure are not tried again
  // (tripped when a download fails); `reported` hosts already have a failed
  // row in the summary, so later rows on them are skipped
  const tripped = new Set<string>();
  const reported = new Set<string>();

  // Fetch window: rows [i, i + concurrency) are being fetched or waiting;
  // rows before `next` were processed and are never fetched again
  let next = 0;
  const fetches = new Map<number, Promise<Fetched>>();
  const startFetch = (i: number) => {
    if (i >= toRun.length || fetches.has(i) || i < next) return;
    const { entry } = toRun[i];
    const origin = entry.origin!;
    fetches.set(i, (async (): Promise<Fetched> => {
      try {
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
        if (origin.type === "local") {
          return { ok: true, buffer: await origin.file.arrayBuffer() };
        }
        const urls = [origin.url, ...(origin.altUrls ?? [])].filter(
          (u) => opts.allowUrl?.(u) ?? true,
        );
        if (urls.length === 0) {
          return { ok: false, error: new Error("download URL not allowed") };
        }
        let firstError: unknown;
        let connectFailures = true;
        for (const url of urls) {
          const host = hostOf(url);
          if (tripped.has(host)) continue;
          onRow(entry.key, { phase: "downloading", percent: 0 });
          try {
            const file = await deps.download(url, entry.filename, {
              signal,
              onProgress: (percent) =>
                onRow(entry.key, { phase: "downloading", percent }),
            });
            return { ok: true, buffer: await file.arrayBuffer() };
          } catch (e) {
            if (signal.aborted) throw e;
            firstError ??= e;
            if (e instanceof TypeError) tripped.add(host);
            else connectFailures = false;
          }
        }
        return {
          ok: false,
          error: firstError ?? new TypeError("host blocked"),
          hosts: connectFailures ? urls.map(hostOf) : undefined,
        };
      } catch (error) {
        return { ok: false, error };
      }
    })());
  };

  try {
    for (let i = 0; i < toRun.length; i++) {
      const row = toRun[i];
      const { key, filename } = row.entry;

      if (signal.aborted) {
        summary.cancelled = true;
        for (let j = i; j < toRun.length; j++) {
          onRow(toRun[j].entry.key, { phase: "cancelled" });
          summary.notRun++;
        }
        break;
      }

      for (let j = i; j < i + concurrency; j++) startFetch(j);
      const fetched = await fetches.get(i)!;
      fetches.delete(i); // release the buffer reference once processed
      next = i + 1;

      if (!fetched.ok) {
        if (signal.aborted) {
          i--; // re-enter the loop top, which marks this and the rest cancelled
          continue;
        }
        const { hosts } = fetched;
        if (hosts && hosts.every((h) => reported.has(h))) {
          onRow(key, { phase: "skipped", reason: "host blocked" });
          summary.skipped.push({ key, filename, reason: "host-blocked", detail: hosts[0] });
          continue;
        }
        const error = describeDownloadError(fetched.error);
        onRow(key, { phase: "failed", error });
        summary.failed.push(
          hosts ? { key, filename, error, host: hosts[0] } : { key, filename, error },
        );
        for (const h of hosts ?? []) reported.add(h);
        continue;
      }

      let verified: FetchedRow;
      try {
        const expected = expectedHashes(row.entry);
        const check = await (deps.verify ?? verifyWithWebCrypto)(fetched.buffer, expected);
        const unchecked = check !== "ok" && Object.keys(expected).length > 0;
        if (check === "mismatch" || (unchecked && opts.requireHash)) {
          const error = check === "mismatch" ? "hash mismatch" : "hash not verified";
          onRow(key, { phase: "failed", error });
          summary.failed.push({ key, filename, error });
          continue;
        }
        const hashVerified = check === "ok";
        const sha512 =
          hashVerified && expected.sha512
            ? expected.sha512
            : await (deps.sha512 ?? trySha512Hex)(fetched.buffer);
        verified = { row, buffer: fetched.buffer, hashVerified, ...(sha512 ? { sha512 } : {}) };
      } catch (e) {
        const error = getErrorMessage(e);
        onRow(key, { phase: "failed", error });
        summary.failed.push({ key, filename, error });
        continue;
      }
      yield verified;
    }
  } finally {
    // Settle the downloads still in flight (aborted when the caller stopped
    // early or cancelled)
    opts.signal.removeEventListener("abort", forward);
    inner.abort();
    await Promise.all(fetches.values());
  }
}

/**
 * Import the selected rows: fetchRows, then the caller's extract and commit
 * for each fetched JAR, one at a time.
 */
export async function runImport<R>(
  rows: ReviewRow[],
  deps: RunnerDeps<R>,
  opts: RunOptions,
): Promise<ImportSummary> {
  const onRow = opts.onRow ?? noProgress;
  const summary: ImportSummary = {
    imported: 0,
    counts: {},
    skipped: [],
    failed: [],
    notRun: 0,
    cancelled: false,
  };

  for await (const { row, buffer, hashVerified, sha512 } of fetchStage(rows, deps, opts, summary)) {
    const { entry, modrinthProject, modrinthProjectId, modrinthVersionId } = row;
    const { key, filename } = entry;
    try {
      onRow(key, { phase: "extracting" });
      let result: R;
      try {
        result = await deps.extract(buffer, filename);
      } catch (e) {
        if ((deps.isNoContent ?? defaultIsNoContent)(e)) {
          onRow(key, { phase: "skipped", reason: "no items" });
          summary.skipped.push({ key, filename, reason: "no-items" });
          continue;
        }
        throw e;
      }

      const committed = await deps.commit(result, {
        packName: opts.packName,
        sha512,
        hashVerified,
        modrinthProjectId,
        modrinthVersionId,
        iconUrl: modrinthProject?.iconUrl ?? undefined,
        displayName: modrinthProject?.title,
      });
      if (committed.status === "duplicate") {
        onRow(key, { phase: "skipped", reason: "already imported" });
        summary.skipped.push({ key, filename, reason: "already-imported" });
        continue;
      }
      if (committed.status === "skipped") {
        onRow(key, { phase: "skipped", reason: committed.reason ?? "skipped" });
        summary.skipped.push(
          committed.reason
            ? { key, filename, reason: "commit-skipped", detail: committed.reason }
            : { key, filename, reason: "commit-skipped" },
        );
        continue;
      }
      const counts = { ...committed.counts };
      onRow(key, { phase: "done", counts });
      summary.imported++;
      for (const [name, n] of Object.entries(counts)) {
        summary.counts[name] = (summary.counts[name] ?? 0) + n;
      }
    } catch (e) {
      const error = getErrorMessage(e);
      onRow(key, { phase: "failed", error });
      summary.failed.push({ key, filename, error });
    }
  }
  return summary;
}
