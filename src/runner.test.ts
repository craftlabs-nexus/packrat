import { describe, expect, it, vi } from "vitest";
import { runImport, type RowProgress, type RunnerDeps } from "./runner";
import type { ExtractedJar } from "./types";

/** CategoryCraft's extraction error, as the runner's default recognizes it. */
class JarValidationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "JarValidationError";
    this.code = code;
  }
}

/** The shape of CategoryCraft's extraction result that the runner reads. */
interface TestResult extends ExtractedJar {
  filename: string;
  type: string;
  namespaces: string[];
  textures: Map<string, string>;
  warnings: string[];
}
import type { PackEntry, ReviewRow, ReviewStatus } from "./types";

function row(
  name: string,
  opts: {
    remote?: boolean;
    status?: ReviewStatus;
    selected?: boolean;
    sha512?: string;
    /** remote download URLs (implies remote) */
    urls?: string[];
  } = {},
): ReviewRow {
  const status = opts.status ?? { kind: "import" };
  const entry: PackEntry = {
    key: name,
    filename: name,
    sha512: opts.sha512,
    origin: opts.urls
      ? { type: "remote", url: opts.urls[0], altUrls: opts.urls.slice(1) }
      : opts.remote
        ? { type: "remote", url: `https://cdn/${name}` }
        : { type: "local", file: new File([name], name), relativePath: name },
  };
  return {
    entry,
    status,
    selectable: true,
    selected: opts.selected ?? status.kind === "import",
    title: name,
  };
}

function result(items: number, tags = 1, hasCode = true): TestResult {
  return {
    filename: "x.jar",
    type: "mod",
    hasCode,
    namespaces: ["x"],
    data: {
      items: Array.from({ length: items }, (_, i) => ({
        id: `x:i${i}`,
        namespace: "x",
        localId: `i${i}`,
        displayName: `I${i}`,
        sourceId: "",
      })),
      tags: Object.fromEntries(Array.from({ length: tags }, (_, i) => [`x:t${i}`, []])),
    },
    textures: new Map(),
    warnings: [],
  };
}

function deps(overrides: Partial<RunnerDeps<TestResult>> = {}): RunnerDeps<TestResult> {
  return {
    download: vi.fn(async (_url: string, filename: string) => new File([filename], filename)),
    extract: vi.fn(async () => result(2)),
    commit: vi.fn(async (r: TestResult) => ({
      status: "added" as const,
      itemCount: r.data.items.length,
      tagCount: Object.keys(r.data.tags).length,
    })),
    hash: vi.fn(async (buffer: ArrayBuffer) => `h-${new TextDecoder().decode(buffer)}`),
    ...overrides,
  };
}

function collect() {
  const events: [string, RowProgress][] = [];
  return { events, onRow: (key: string, p: RowProgress) => events.push([key, p]) };
}

describe("runImport", () => {
  it("imports selected rows in order with pack metadata and sums the summary", async () => {
    const d = deps();
    const { events, onRow } = collect();
    const rows = [row("a.jar"), row("b.jar", { remote: true })];
    rows[1].modrinthProjectId = "P1";
    rows[1].modrinthVersionId = "V1";
    rows[1].modrinthProject = {
      id: "P1",
      title: "Bee Mod",
      iconUrl: "https://cdn/b.png",
      clientSide: "required",
      serverSide: "required",
    };

    const summary = await runImport(rows, d, {
      signal: new AbortController().signal,
      packName: "Pack",
      onRow,
    });

    expect(summary).toEqual({
      imported: 2,
      items: 4,
      tags: 2,
      skipped: [],
      failed: [],
      notRun: 0,
      cancelled: false,
    });
    expect((d.extract as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(["a.jar", "b.jar"]);
    expect((d.commit as ReturnType<typeof vi.fn>).mock.calls[1][1]).toEqual({
      importSource: "pack",
      packName: "Pack",
      sha512: "h-b.jar",
      modrinthProjectId: "P1",
      modrinthVersionId: "V1",
      iconUrl: "https://cdn/b.png",
      displayName: "Bee Mod",
    });
    expect(events.filter(([k]) => k === "b.jar").map(([, p]) => p.phase)).toEqual([
      "queued",
      "downloading",
      "extracting",
      "done",
    ]);
  });

  it("reports unselected and plan-skipped rows in the summary without running them", async () => {
    const d = deps();
    const summary = await runImport(
      [
        row("client.jar", { status: { kind: "skip", reason: "client-only" } }),
        row("unticked.jar", { selected: false }),
        row("cf", { status: { kind: "unresolvable", reason: "API key required" } }),
      ],
      d,
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.skipped).toEqual([
      { key: "client.jar", filename: "client.jar", reason: "client-only", detail: undefined },
      { key: "unticked.jar", filename: "unticked.jar", reason: "not-selected" },
      { key: "cf", filename: "cf", reason: "unresolvable", detail: "API key required" },
    ]);
    expect(d.extract).not.toHaveBeenCalled();
  });

  it("runs a ticked client-only row", async () => {
    const r = row("client.jar", { status: { kind: "skip", reason: "client-only" }, selected: true });
    const summary = await runImport([r], deps(), { signal: new AbortController().signal, onRow: () => {} });
    expect(summary.imported).toBe(1);
  });

  it("keeps at most downloadConcurrency downloads in flight", async () => {
    let active = 0;
    let peak = 0;
    const d = deps({
      download: vi.fn(async (_u: string, filename: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return new File([filename], filename);
      }),
    });
    const rows = Array.from({ length: 8 }, (_, i) => row(`r${i}.jar`, { remote: true }));
    const summary = await runImport(rows, d, {
      signal: new AbortController().signal,
      downloadConcurrency: 3,
      onRow: () => {},
    });
    expect(summary.imported).toBe(8);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("counts NO_CONTENT and empty results as skipped (no items), not failed", async () => {
    const d = deps({
      extract: vi.fn(async (_b: ArrayBuffer, name: string) => {
        if (name === "lib.jar") throw new JarValidationError("nothing", "NO_CONTENT");
        if (name === "datapack.jar") return result(0, 3, false);
        if (name === "empty.jar") return result(0, 0);
        return result(1);
      }),
    });
    const summary = await runImport(
      [row("lib.jar"), row("datapack.jar"), row("empty.jar"), row("ok.jar")],
      d,
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.imported).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped.map((s) => [s.filename, s.reason])).toEqual([
      ["lib.jar", "no-items"],
      ["datapack.jar", "no-items"],
      ["empty.jar", "no-items"],
    ]);
    expect(d.commit).toHaveBeenCalledTimes(1);
  });

  it("imports a mod with code and item tags but no items (tags only)", async () => {
    const d = deps({ extract: vi.fn(async () => result(0, 3)) });
    const summary = await runImport([row("chains.jar")], d, {
      signal: new AbortController().signal,
      onRow: () => {},
    });
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toEqual([]);
    expect(d.commit).toHaveBeenCalledTimes(1);
  });

  it("fails rows with a hash mismatch, extraction errors or blocked downloads", async () => {
    const d = deps({
      download: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      extract: vi.fn(async (_b: ArrayBuffer, name: string) => {
        if (name === "broken.jar") throw new Error("Failed to read JAR file: bad zip");
        return result(1);
      }),
    });
    const summary = await runImport(
      [
        row("tampered.jar", { sha512: "expected" }),
        row("broken.jar"),
        row("blocked.jar", { remote: true }),
        row("ok.jar", { sha512: "h-ok.jar" }),
      ],
      d,
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.failed).toEqual([
      { key: "tampered.jar", filename: "tampered.jar", error: "hash mismatch" },
      { key: "broken.jar", filename: "broken.jar", error: "Failed to read JAR file: bad zip" },
      {
        key: "blocked.jar",
        filename: "blocked.jar",
        error: "download blocked (CORS) or offline",
        host: "cdn",
      },
    ]);
    expect(summary.imported).toBe(1);
  });

  it("tries the next URL when a download can't connect", async () => {
    const download = vi.fn(async (url: string, filename: string) => {
      if (url.startsWith("https://a.example/")) throw new TypeError("Failed to fetch");
      return new File([filename], filename);
    });
    const summary = await runImport(
      [row("m.jar", { urls: ["https://a.example/m.jar", "https://b.example/m.jar"] })],
      deps({ download }),
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.imported).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(download.mock.calls.map((c) => c[0])).toEqual([
      "https://a.example/m.jar",
      "https://b.example/m.jar",
    ]);
  });

  it("fails the first row on a host that can't connect and skips the rest on it", async () => {
    const download = vi.fn(async (url: string, filename: string) => {
      if (url.startsWith("https://files.example/")) throw new TypeError("Failed to fetch");
      return new File([filename], filename);
    });
    const rows = [
      ...["a", "b", "c", "d"].map((n) => row(`${n}.jar`, { urls: [`https://files.example/${n}.jar`] })),
      row("ok.jar", { urls: ["https://cdn.example/ok.jar"] }),
    ];
    const { events, onRow } = collect();
    const summary = await runImport(rows, deps({ download }), {
      signal: new AbortController().signal,
      downloadConcurrency: 1,
      onRow,
    });
    expect(summary.failed).toEqual([
      { key: "a.jar", filename: "a.jar", error: "download blocked (CORS) or offline", host: "files.example" },
    ]);
    expect(summary.skipped).toEqual(
      ["b", "c", "d"].map((n) => ({
        key: `${n}.jar`,
        filename: `${n}.jar`,
        reason: "host-blocked",
        detail: "files.example",
      })),
    );
    expect(summary.imported).toBe(1);
    // the breaker saves the requests after the first failure
    expect(download.mock.calls.map((c) => c[0])).toEqual([
      "https://files.example/a.jar",
      "https://cdn.example/ok.jar",
    ]);
    expect(events.find(([k, p]) => k === "b.jar" && p.phase === "skipped")?.[1]).toEqual({
      phase: "skipped",
      reason: "host blocked",
    });
  });

  it("offline: the first row on each host fails, prefetched rows are skipped", async () => {
    const d = deps({
      download: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const summary = await runImport(
      [
        row("a.jar", { urls: ["https://one.example/a.jar"] }),
        row("b.jar", { urls: ["https://one.example/b.jar"] }),
        row("c.jar", { urls: ["https://two.example/c.jar"] }),
        row("local.jar"),
      ],
      d,
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.failed.map((f) => [f.filename, f.host])).toEqual([
      ["a.jar", "one.example"],
      ["c.jar", "two.example"],
    ]);
    expect(summary.skipped.map((s) => [s.filename, s.reason, s.detail])).toEqual([
      ["b.jar", "host-blocked", "one.example"],
    ]);
    expect(summary.imported).toBe(1);
  });

  it("does not trip the breaker on HTTP errors", async () => {
    const d = deps({
      download: vi.fn(async () => {
        throw new Error("Download failed: 404 Not Found");
      }),
    });
    const summary = await runImport(
      [
        row("a.jar", { urls: ["https://files.example/a.jar"] }),
        row("b.jar", { urls: ["https://files.example/b.jar"] }),
      ],
      d,
      { signal: new AbortController().signal, onRow: () => {} },
    );
    expect(summary.failed).toEqual([
      { key: "a.jar", filename: "a.jar", error: "Download failed: 404 Not Found" },
      { key: "b.jar", filename: "b.jar", error: "Download failed: 404 Not Found" },
    ]);
    expect(d.download).toHaveBeenCalledTimes(2);
  });

  it("skips a duplicate found at commit time", async () => {
    const d = deps({
      commit: vi.fn(async () => ({ status: "duplicate" as const, itemCount: 0, tagCount: 0 })),
    });
    const summary = await runImport([row("dup.jar")], d, {
      signal: new AbortController().signal,
      onRow: () => {},
    });
    expect(summary.skipped).toEqual([{ key: "dup.jar", filename: "dup.jar", reason: "already-imported" }]);
  });

  it("cancels the remaining rows; committed sources stay", async () => {
    const controller = new AbortController();
    const d = deps({
      commit: vi.fn(async (r: TestResult) => {
        controller.abort(); // the user cancels while the first row commits
        return { status: "added" as const, itemCount: r.data.items.length, tagCount: 0 };
      }),
      download: vi.fn(
        (_u: string, filename: string, o: { signal: AbortSignal }) =>
          new Promise<File>((resolve, reject) => {
            const t = setTimeout(() => resolve(new File([filename], filename)), 50);
            o.signal.addEventListener("abort", () => {
              clearTimeout(t);
              const e = new Error("Download cancelled");
              e.name = "DownloadAbortedError";
              reject(e);
            });
          }),
      ),
    });
    const { events, onRow } = collect();
    const summary = await runImport(
      [row("a.jar"), row("b.jar", { remote: true }), row("c.jar", { remote: true })],
      d,
      { signal: controller.signal, onRow },
    );
    expect(summary.imported).toBe(1);
    expect(summary.cancelled).toBe(true);
    expect(summary.notRun).toBe(2);
    expect(summary.failed).toEqual([]);
    expect(events.filter(([, p]) => p.phase === "cancelled").map(([k]) => k)).toEqual(["b.jar", "c.jar"]);
  });
});
