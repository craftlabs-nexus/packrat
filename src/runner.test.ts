import { describe, expect, it, vi } from "vitest";
import { runImport, type RowProgress, type RunnerDeps } from "./runner";
import type { ExpectedHashes } from "./hashing";
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
    // the bytes of a test file are its name; its "hash" is h-<name>
    verify: vi.fn(async (buffer: ArrayBuffer, expected: ExpectedHashes) => {
      if (!expected.sha512) return "unavailable" as const;
      return expected.sha512 === `h-${new TextDecoder().decode(buffer)}` ? ("ok" as const) : ("mismatch" as const);
    }),
    sha512: vi.fn(async (buffer: ArrayBuffer) => `h-${new TextDecoder().decode(buffer)}`),
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
      hashVerified: false,
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

  it("verifies sha1 and sha256 too, and records only a verified or computed sha512", async () => {
    const verify = vi.fn(async () => "ok" as const);
    const sha512 = vi.fn(async () => "computed");
    const d = deps({ verify, sha512 });
    const rows = [row("a.jar", { remote: true }), row("b.jar", { remote: true, sha512: "AA" })];
    rows[0].entry.sha1 = "S1";
    rows[0].entry.sha256 = "S256";
    await runImport(rows, d, { signal: new AbortController().signal, onRow: () => {} });
    expect(verify.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ sha1: "s1", sha256: "s256" }, { sha512: "aa" }]);
    const metadata = (d.commit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(metadata.map((m) => [m.sha512, m.hashVerified])).toEqual([
      ["computed", true],
      ["aa", true],
    ]);
    expect(sha512).toHaveBeenCalledTimes(1);
  });

  it("imports an unchecked row unless requireHash, which fails it", async () => {
    const verify = vi.fn(async () => "unavailable" as const);
    const sha512 = vi.fn(async () => undefined);
    const rows = () => [row("listed.jar", { remote: true, sha512: "claimed" }), row("unlisted.jar", { remote: true })];

    const d = deps({ verify, sha512 });
    const summary = await runImport(rows(), d, { signal: new AbortController().signal, onRow: () => {} });
    expect(summary.imported).toBe(2);
    // the pack's unverified claim is not passed on as the JAR's sha512
    expect((d.commit as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      sha512: undefined,
      hashVerified: false,
    });

    const strict = await runImport(rows(), deps({ verify, sha512 }), {
      signal: new AbortController().signal,
      onRow: () => {},
      requireHash: true,
    });
    expect(strict.imported).toBe(1);
    expect(strict.failed).toEqual([{ key: "listed.jar", filename: "listed.jar", error: "hash not verified" }]);
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

  it("never fetches a URL that allowUrl refuses", async () => {
    const download = vi.fn(async (url: string, filename: string) => {
      if (url.startsWith("https://a.example/")) throw new TypeError("Failed to fetch");
      return new File([filename], filename);
    });
    const allowUrl = (url: string) => !url.startsWith("https://evil.example/");
    const summary = await runImport(
      [
        row("m.jar", { urls: ["https://a.example/m.jar", "https://evil.example/m.jar", "https://b.example/m.jar"] }),
        row("x.jar", { urls: ["https://evil.example/x.jar"] }),
      ],
      deps({ download }),
      { signal: new AbortController().signal, onRow: () => {}, allowUrl },
    );
    expect(download.mock.calls.map((c) => c[0])).toEqual([
      "https://a.example/m.jar",
      "https://b.example/m.jar",
    ]);
    expect(summary.imported).toBe(1);
    expect(summary.failed).toEqual([{ key: "x.jar", filename: "x.jar", error: "download URL not allowed" }]);
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

  it("cancels on the signal whatever the download rejects with", async () => {
    const controller = new AbortController();
    const d = deps({
      download: vi.fn(
        (_u: string, _f: string, o: { signal: AbortSignal }) =>
          new Promise<File>((_resolve, reject) => {
            // rejects with the abort reason: here an Error, not an AbortError
            o.signal.addEventListener("abort", () => reject(o.signal.reason));
            setTimeout(() => controller.abort(new Error("stopped by the user")), 1);
          }),
      ),
    });
    const summary = await runImport([row("a.jar", { remote: true }), row("b.jar", { remote: true })], d, {
      signal: controller.signal,
      onRow: () => {},
    });
    expect(summary).toMatchObject({ cancelled: true, notRun: 2, failed: [], imported: 0 });

    const controller2 = new AbortController();
    const summary2 = await runImport(
      [row("c.jar", { remote: true })],
      deps({
        download: vi.fn(async () => {
          controller2.abort();
          throw new Error("socket closed");
        }),
      }),
      { signal: controller2.signal, onRow: () => {} },
    );
    expect(summary2).toMatchObject({ cancelled: true, notRun: 1, failed: [] });
  });

  it("rejects with a real DOMException AbortError and counts it as cancelled", async () => {
    const controller = new AbortController();
    const d = deps({
      download: vi.fn(async () => {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    });
    const summary = await runImport([row("a.jar", { remote: true })], d, {
      signal: controller.signal,
      onRow: () => {},
    });
    expect(summary).toMatchObject({ cancelled: true, notRun: 1, failed: [] });
  });

  it("runs nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps();
    const { events, onRow } = collect();
    const summary = await runImport([row("a.jar"), row("b.jar", { remote: true })], d, {
      signal: controller.signal,
      onRow,
    });
    expect(summary).toMatchObject({ cancelled: true, notRun: 2, imported: 0, failed: [] });
    expect(d.download).not.toHaveBeenCalled();
    expect(d.extract).not.toHaveBeenCalled();
    expect(events.map(([k, p]) => [k, p.phase])).toEqual([
      ["a.jar", "queued"],
      ["b.jar", "queued"],
      ["a.jar", "cancelled"],
      ["b.jar", "cancelled"],
    ]);
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
