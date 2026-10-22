/**
 * Run an import plan: fetch the selected rows' bytes (local Files, or
 * downloads with up to `downloadConcurrency` in flight/waiting), then verify
 * the hash, extract and commit strictly one at a time (bounds memory: one
 * extraction plus a few downloaded Files). Cancellable between rows;
 * sources already committed stay.
 *
 * A download that fails to connect (CORS or offline: fetch's TypeError)
 * tries the file's altUrls, and trips a per-host breaker: the first row on
 * that host is reported failed, later rows on it are skipped ("host-blocked")
 * without another request.
 */
import { getErrorMessage } from "./utils";
import type { ExtractedJar, ImportMetadata, PackEntry, ReviewRow, SkipReason } from "./types";

export type RowProgress =
  | { phase: "queued" }
  | { phase: "downloading"; percent: number }
  | { phase: "extracting" }
  | { phase: "done"; itemCount: number; tagCount: number }
  | { phase: "skipped"; reason: string }
  | { phase: "failed"; error: string }
  | { phase: "cancelled" };

export interface RunnerDeps<R extends ExtractedJar = ExtractedJar> {
  download: (
    url: string,
    filename: string,
    options: { onProgress: (percent: number) => void; signal: AbortSignal },
  ) => Promise<File>;
  extract: (buffer: ArrayBuffer, filename: string) => Promise<R>;
  commit: (
    result: R,
    metadata: ImportMetadata,
  ) => Promise<{ status: "added" | "duplicate"; itemCount: number; tagCount: number }>;
  /** Lowercase hex sha512; undefined when hashing is unavailable */
  hash: (buffer: ArrayBuffer) => Promise<string | undefined>;
  /**
   * An extraction error that means the JAR has nothing to import (the row
   * is skipped as "no items", not failed). Default: an error named
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
  | "host-blocked";

export interface ImportSummary {
  imported: number;
  items: number;
  tags: number;
  skipped: { key: string; filename: string; reason: SummarySkipReason; detail?: string }[];
  /** host: set when the download failed to connect (CORS or offline) */
  failed: { key: string; filename: string; error: string; host?: string }[];
  /** Selected rows not run because the import was cancelled */
  notRun: number;
  cancelled: boolean;
}

export interface RunOptions {
  signal: AbortSignal;
  downloadConcurrency?: number;
  packName?: string;
  onRow: (key: string, progress: RowProgress) => void;
}

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

function isAbort(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === "DownloadAbortedError") ||
    (e instanceof DOMException && e.name === "AbortError")
  );
}

function rowFilename(entry: PackEntry): string {
  return entry.filename;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function runImport<R extends ExtractedJar>(
  rows: ReviewRow[],
  deps: RunnerDeps<R>,
  opts: RunOptions,
): Promise<ImportSummary> {
  const { signal, onRow, packName } = opts;
  const concurrency = Math.max(
    1,
    opts.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
  );
  const summary: ImportSummary = {
    imported: 0,
    items: 0,
    tags: 0,
    skipped: [],
    failed: [],
    notRun: 0,
    cancelled: false,
  };

  // Rows that won't run are reported as skipped with their plan status
  const toRun: ReviewRow[] = [];
  for (const row of rows) {
    const { entry, status } = row;
    if (row.selected && entry.origin && status.kind !== "unresolvable") {
      toRun.push(row);
    } else if (status.kind === "unresolvable") {
      summary.skipped.push({
        key: entry.key,
        filename: rowFilename(entry),
        reason: "unresolvable",
        detail: status.reason,
      });
    } else if (status.kind === "skip") {
      summary.skipped.push({
        key: entry.key,
        filename: rowFilename(entry),
        reason: status.reason,
        detail: status.detail,
      });
    } else {
      summary.skipped.push({
        key: entry.key,
        filename: rowFilename(entry),
        reason: "not-selected",
      });
    }
  }
  for (const row of toRun) onRow(row.entry.key, { phase: "queued" });

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
        const urls = [origin.url, ...(origin.altUrls ?? [])];
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
            if (isAbort(e) && signal.aborted) throw e;
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

  for (let i = 0; i < toRun.length; i++) {
    const { entry, modrinthProject, modrinthProjectId, modrinthVersionId } =
      toRun[i];
    const key = entry.key;
    const filename = rowFilename(entry);

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
      if (isAbort(fetched.error) && signal.aborted) {
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

    try {
      const computed = await deps.hash(fetched.buffer);
      if (entry.sha512 && computed && computed !== entry.sha512.toLowerCase()) {
        const error = "hash mismatch";
        onRow(key, { phase: "failed", error });
        summary.failed.push({ key, filename, error });
        continue;
      }
      const sha512 = computed ?? entry.sha512;

      onRow(key, { phase: "extracting" });
      let result: R;
      try {
        result = await deps.extract(fetched.buffer, filename);
      } catch (e) {
        if ((deps.isNoContent ?? defaultIsNoContent)(e)) {
          onRow(key, { phase: "skipped", reason: "no items" });
          summary.skipped.push({ key, filename, reason: "no-items" });
          continue;
        }
        throw e;
      }
      // No items: still a source when a mod with code adds item tags
      // (tags-only); never for resource/data packs (no code)
      const tagsOnly =
        result.hasCode && Object.keys(result.data.tags).length > 0;
      if (result.data.items.length === 0 && !tagsOnly) {
        onRow(key, { phase: "skipped", reason: "no items" });
        summary.skipped.push({ key, filename, reason: "no-items" });
        continue;
      }

      const committed = await deps.commit(result, {
        importSource: "pack",
        packName,
        sha512,
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
      onRow(key, {
        phase: "done",
        itemCount: committed.itemCount,
        tagCount: committed.tagCount,
      });
      summary.imported++;
      summary.items += committed.itemCount;
      summary.tags += committed.tagCount;
    } catch (e) {
      const error = getErrorMessage(e);
      onRow(key, { phase: "failed", error });
      summary.failed.push({ key, filename, error });
    }
  }

  // Settle prefetches left behind by a cancel (their downloads were aborted)
  await Promise.all(fetches.values());
  return summary;
}
