import { describe, expect, it, vi } from "vitest";
import { buildPlan, proposeVersionAction, type BuildPlanContext } from "./plan";
import type { ResolveResult } from "./modrinthResolve";
import type { LocalJarScan, PackAnalysis, PackEntry } from "./types";
import type { ExistingSource } from "./types";

const CODE_SCAN: LocalJarScan = {
  hasClassFiles: true,
  hasItemDefinitions: true,
  hasItemTags: false,
  loaders: ["fabric"],
  size: 1,
};

function local(name: string): PackEntry {
  return {
    key: `mods/${name}`,
    filename: name,
    origin: { type: "local", file: new File([name], name), relativePath: `mods/${name}` },
  };
}

function remote(name: string, extra: Partial<PackEntry> = {}): PackEntry {
  return {
    key: `https://cdn/${name}`,
    filename: name,
    origin: { type: "remote", url: `https://cdn.modrinth.com/${name}` },
    ...extra,
  };
}

/** A remote entry downloaded from `url` (keyed by it). */
function at(url: string, extra: Partial<PackEntry> = {}): PackEntry {
  return {
    key: url,
    filename: url.slice(url.lastIndexOf("/") + 1),
    origin: { type: "remote", url },
    ...extra,
  };
}

function source(overrides: Partial<ExistingSource>): ExistingSource {
  return { filename: "existing.jar", ...overrides };
}

const VERSIONS = [
  { version: "26.3", coversVersions: ["26.3"] },
  { version: "26.2", coversVersions: ["26.2", "26.2.1"] },
];

function ctx(overrides: Partial<BuildPlanContext> = {}): BuildPlanContext {
  return {
    existingSources: [],
    availableVersions: VERSIONS,
    selectedBundledVersion: "26.3",
    pageProtocol: "https:",
    // Hash = file contents, scan by filename
    hash: async (buffer) => `hash-${new TextDecoder().decode(buffer)}`,
    scan: async () => CODE_SCAN,
    resolve: async () => ({ resolved: new Map() }),
    ...overrides,
  };
}

function analysis(entries: PackEntry[], minecraftVersion?: string): PackAnalysis {
  return { manifest: { kind: "folder", name: "P", minecraftVersion }, entries };
}

function statusOf(plan: Awaited<ReturnType<typeof buildPlan>>, filename: string) {
  const row = plan.rows.find((r) => r.entry.filename === filename)!;
  return { ...row.status, selectable: row.selectable, selected: row.selected };
}

describe("buildPlan", () => {
  it("hashes and scans local JARs with progress, imports code mods with items", async () => {
    const progress: [number, number][] = [];
    const plan = await buildPlan(
      analysis([local("a.jar"), local("b.jar")]),
      ctx({ onProgress: (d, t) => progress.push([d, t]) }),
    );
    expect(progress).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(plan.rows.map((r) => r.entry.sha512)).toEqual(["hash-a.jar", "hash-b.jar"]);
    expect(statusOf(plan, "a.jar")).toMatchObject({ kind: "import", selectable: true, selected: true });
  });

  it("marks entries the pack cannot fetch as unresolvable", async () => {
    const plan = await buildPlan(
      analysis([{ key: "cf", filename: "CurseForge project 1 file 2", unresolvable: "API key required" }]),
      ctx(),
    );
    expect(statusOf(plan, "CurseForge project 1 file 2")).toMatchObject({
      kind: "unresolvable",
      reason: "API key required",
      selectable: false,
      selected: false,
    });
  });

  it("marks unreadable local JARs as unresolvable", async () => {
    const plan = await buildPlan(
      analysis([local("bad.jar")]),
      ctx({
        scan: async () => {
          throw new Error("End of data reached");
        },
      }),
    );
    expect(statusOf(plan, "bad.jar")).toMatchObject({
      kind: "unresolvable",
      reason: "Not a readable JAR: End of data reached",
    });
  });

  it("skips already imported mods by hash, Modrinth project, mod id and filename", async () => {
    const resolve = async (): Promise<ResolveResult> => ({
      resolved: new Map([["https://cdn/r.jar", { projectId: "P1" }]]),
    });
    const plan = await buildPlan(
      analysis([local("h.jar"), remote("r.jar"), local("m.jar"), remote("f.jar")]),
      ctx({
        existingSources: [
          source({ sha512: "hash-h.jar", displayName: "By Hash" }),
          source({ modrinthProjectId: "P1", modDisplayName: "By Project" }),
          source({ modId: "mmod", filename: "other.jar" }),
          source({ filename: "f.jar" }),
        ],
        resolve,
        scan: async (buffer) => ({
          ...CODE_SCAN,
          modId: new TextDecoder().decode(buffer) === "m.jar" ? "mmod" : undefined,
        }),
      }),
    );
    expect(statusOf(plan, "h.jar")).toMatchObject({ reason: "already-imported", detail: "By Hash" });
    expect(statusOf(plan, "r.jar")).toMatchObject({ reason: "already-imported", detail: "By Project" });
    expect(statusOf(plan, "m.jar")).toMatchObject({ reason: "already-imported", detail: "mmod" });
    expect(statusOf(plan, "f.jar")).toMatchObject({ reason: "already-imported", detail: "f" });
    expect(plan.rows.every((r) => !r.selectable)).toBe(true);
  });

  it("matches existing sources by mod id and filename only where they allow it", async () => {
    const plan = await buildPlan(
      analysis([local("m.jar"), local("f.jar")]),
      ctx({
        existingSources: [
          source({ modId: "mmod", filename: "other.jar", matchByModId: false }),
          source({ filename: "f.jar", matchByFilename: false }),
        ],
        scan: async (buffer) => ({
          ...CODE_SCAN,
          modId: new TextDecoder().decode(buffer) === "m.jar" ? "mmod" : undefined,
        }),
      }),
    );
    expect(statusOf(plan, "m.jar").kind).toBe("import");
    expect(statusOf(plan, "f.jar").kind).toBe("import");
  });

  it("matches an existing source's sha512 in any case", async () => {
    const plan = await buildPlan(
      analysis([remote("r.jar", { sha512: "abcdef" })]),
      ctx({ existingSources: [source({ sha512: "ABCDEF", displayName: "Upper" })] }),
    );
    expect(statusOf(plan, "r.jar")).toMatchObject({ reason: "already-imported", detail: "Upper" });
  });

  it("needs no bundled versions, existing sources or page protocol", async () => {
    const plan = await buildPlan(analysis([remote("r.jar")], "26.2"), {
      resolve: async () => ({ resolved: new Map() }),
    });
    expect(plan.versionAction).toEqual({ kind: "none" });
    expect(statusOf(plan, "r.jar").kind).toBe("import");
  });

  it("skips the second copy of a mod in the pack", async () => {
    const plan = await buildPlan(
      analysis([local("one-1.0.jar"), local("one-2.0.jar")]),
      ctx({ scan: async () => ({ ...CODE_SCAN, modId: "one" }) }),
    );
    expect(statusOf(plan, "one-1.0.jar").kind).toBe("import");
    expect(statusOf(plan, "one-2.0.jar")).toMatchObject({ reason: "duplicate-in-pack" });
  });

  it("skips JARs without code, or without items and item tags (not selectable)", async () => {
    const plan = await buildPlan(
      analysis([local("data.jar"), local("lib.jar")]),
      ctx({
        scan: async (buffer) =>
          new TextDecoder().decode(buffer) === "data.jar"
            ? // a data pack's item tags don't count: it has no code
              { ...CODE_SCAN, hasClassFiles: false, hasItemTags: true }
            : { ...CODE_SCAN, hasItemDefinitions: false },
      }),
    );
    expect(statusOf(plan, "data.jar")).toMatchObject({ reason: "no-items", selectable: false });
    expect(statusOf(plan, "lib.jar")).toMatchObject({ reason: "no-items", selectable: false });
  });

  it("imports a mod with code and item tags but no items as tags only", async () => {
    const plan = await buildPlan(
      analysis([local("chains.jar")]),
      ctx({ scan: async () => ({ ...CODE_SCAN, hasItemDefinitions: false, hasItemTags: true }) }),
    );
    const r = plan.rows.find((x) => x.entry.filename === "chains.jar")!;
    expect(r.status).toEqual({ kind: "import", tagsOnly: true });
    expect(r).toMatchObject({ selectable: true, selected: true });
  });

  it("takes a content rule, or none", async () => {
    const entries = [local("data.jar"), local("pack.jar"), local("mod.jar")];
    const scan = async (buffer: ArrayBuffer) => {
      const name = new TextDecoder().decode(buffer);
      return { ...CODE_SCAN, hasClassFiles: name === "mod.jar", hasItemDefinitions: false };
    };
    const contentStatus = vi.fn((s: LocalJarScan, entry: PackEntry) =>
      entry.filename === "pack.jar"
        ? ({ kind: "skip", reason: "no-items", detail: "not a resource pack" } as const)
        : s.hasClassFiles
          ? undefined
          : ({ kind: "import", tagsOnly: true } as const),
    );
    const plan = await buildPlan(analysis(entries), ctx({ scan, contentStatus }));
    expect(contentStatus).toHaveBeenCalledTimes(3);
    expect(statusOf(plan, "data.jar")).toMatchObject({ kind: "import", tagsOnly: true });
    expect(statusOf(plan, "pack.jar")).toMatchObject({ kind: "skip", detail: "not a resource pack" });
    expect(statusOf(plan, "mod.jar")).toMatchObject({ kind: "import" });

    const none = await buildPlan(analysis(entries), ctx({ scan, contentStatus: null }));
    expect(none.rows.map((r) => r.status)).toEqual([{ kind: "import" }, { kind: "import" }, { kind: "import" }]);
  });

  it("does not run the content rule on duplicates or already imported JARs", async () => {
    const contentStatus = vi.fn(() => undefined);
    await buildPlan(
      analysis([local("a.jar"), local("a2.jar"), local("old.jar")]),
      ctx({
        scan: async (b) => ({ ...CODE_SCAN, modId: new TextDecoder().decode(b) === "old.jar" ? "old" : "a" }),
        existingSources: [source({ modId: "old" })],
        contentStatus,
      }),
    );
    expect(contentStatus).toHaveBeenCalledTimes(1);
  });

  it("a content rule's tags-only import still yields to client-only", async () => {
    const plan = await buildPlan(
      analysis([{ ...local("c.jar"), side: "client" }]),
      ctx({ scan: async () => ({ ...CODE_SCAN, hasItemDefinitions: false, hasItemTags: true }) }),
    );
    expect(statusOf(plan, "c.jar")).toMatchObject({ kind: "skip", reason: "client-only" });
  });

  it("keeps client-only mods ticked with skipClientOnly: false", async () => {
    const plan = await buildPlan(
      analysis([remote("c.jar", { side: "client" }), remote("o.jar", { side: "client", optional: true })]),
      ctx({ skipClientOnly: false }),
    );
    expect(statusOf(plan, "c.jar")).toMatchObject({ kind: "import", selected: true });
    expect(statusOf(plan, "o.jar")).toMatchObject({ kind: "skip", reason: "optional" });
  });

  it("does not run the no-items check on remote entries", async () => {
    const plan = await buildPlan(analysis([remote("r.jar")]), ctx());
    expect(statusOf(plan, "r.jar").kind).toBe("import");
  });

  it("offers client-only (pack side or Modrinth sides) and optional mods unticked", async () => {
    const resolve = async (): Promise<ResolveResult> => ({
      resolved: new Map([
        [
          "https://cdn/m.jar",
          {
            projectId: "P1",
            versionId: "V1",
            project: {
              id: "P1",
              title: "Minimap",
              iconUrl: "https://cdn/i.png",
              clientSide: "required",
              serverSide: "unsupported",
            },
          },
        ],
      ]),
    });
    const plan = await buildPlan(
      analysis([
        remote("c.jar", { side: "client" }),
        remote("m.jar", { sha512: "mm" }),
        remote("o.jar", { optional: true }),
      ]),
      ctx({ resolve }),
    );
    expect(statusOf(plan, "c.jar")).toMatchObject({ reason: "client-only", selectable: true, selected: false });
    expect(statusOf(plan, "m.jar")).toMatchObject({ reason: "client-only", selectable: true, selected: false });
    expect(statusOf(plan, "o.jar")).toMatchObject({ reason: "optional", selectable: true, selected: false });

    const row = plan.rows.find((r) => r.entry.filename === "m.jar")!;
    expect(row).toMatchObject({
      title: "Minimap",
      iconUrl: "https://cdn/i.png",
      modrinthProjectId: "P1",
      modrinthVersionId: "V1",
    });
  });

  it("titles rows from the JAR's mod name, else the filename, and sorts by title", async () => {
    const plan = await buildPlan(
      analysis([local("z.jar"), remote("b.jar")]),
      ctx({ scan: async () => ({ ...CODE_SCAN, displayName: "Alpha" }) }),
    );
    expect(plan.rows.map((r) => r.title)).toEqual(["Alpha", "b.jar"]);
  });

  it("adds the Modrinth warning to the notes and keeps going", async () => {
    const plan = await buildPlan(
      analysis([local("a.jar")]),
      ctx({ resolve: async () => ({ resolved: new Map(), warning: "Modrinth lookup failed: x" }) }),
    );
    expect(plan.notes).toEqual(["Modrinth lookup failed: x"]);
    expect(plan.rows[0].status.kind).toBe("import");
  });

  it("only asks Modrinth about entries with a hash or id", async () => {
    const resolve = vi.fn(async () => ({ resolved: new Map() }));
    await buildPlan(
      analysis([remote("nohash.jar"), remote("hash.jar", { sha1: "11" })]),
      ctx({ resolve }),
    );
    expect(resolve).toHaveBeenCalledWith([expect.objectContaining({ filename: "hash.jar" })]);
  });
});

describe("buildPlan download URLs", () => {
  it("marks blocked downloads unresolvable with one note per host", async () => {
    const jars = Array.from({ length: 12 }, (_, i) => at(`http://pack/jars/j${i}.jar`));
    const plan = await buildPlan(
      analysis([
        ...jars,
        at("https://github.com/o/r/releases/download/v1/g.jar"),
        at("http://files.example/h.jar"),
        at("https://cdn.modrinth.com/data/x/m.jar"),
      ]),
      ctx(),
    );
    expect(statusOf(plan, "j0.jar")).toMatchObject({
      kind: "unresolvable",
      reason: "internal host pack (not reachable from a web page)",
      selectable: false,
    });
    expect(statusOf(plan, "g.jar")).toMatchObject({
      kind: "unresolvable",
      reason: "github.com doesn't allow downloads from a web page",
    });
    expect(statusOf(plan, "h.jar")).toMatchObject({
      kind: "unresolvable",
      reason: "http:// download (blocked on an https page)",
    });
    expect(statusOf(plan, "m.jar").kind).toBe("import");
    expect(plan.notes).toEqual([
      "12 files on pack are internal to the server (not reachable from a web page).",
      "1 file on github.com can't be downloaded from a web page (no CORS).",
      "1 file on files.example uses http://, which an https page can't download.",
    ]);
  });

  it("trusts the pack's own origin and http on an http page", async () => {
    const plan = await buildPlan(
      {
        manifest: { kind: "packwiz", packOrigin: "http://pack" },
        entries: [at("http://pack/mods/a.jar"), at("http://files.example/b.jar")],
      },
      ctx({ pageProtocol: "http:" }),
    );
    expect(statusOf(plan, "a.jar").kind).toBe("import");
    expect(plan.rows.find((r) => r.entry.filename === "a.jar")!.download).toEqual({
      kind: "ok",
      via: "pack-origin",
    });
    expect(statusOf(plan, "b.jar").kind).toBe("import");
    expect(plan.notes).toEqual([]);
  });

  it("keeps unverified hosts importable and marks the row", async () => {
    const plan = await buildPlan(analysis([at("https://files.example/u.jar")]), ctx());
    const row = plan.rows[0];
    expect(row.status).toEqual({ kind: "import" });
    expect(row.download).toEqual({ kind: "unverified", host: "files.example" });
  });

  it("downloads a blocked file from Modrinth when its sha512 matches", async () => {
    const gh = "https://github.com/o/r/releases/download/v1/";
    const resolve = vi.fn(
      async (): Promise<ResolveResult> => ({
        resolved: new Map([
          [`${gh}a.jar`, { projectId: "P1", cdnUrl: "https://cdn.modrinth.com/data/P1/a.jar" }],
          // sha1 match only: Modrinth knows the project, but no file URL
          [`${gh}b.jar`, { projectId: "P2" }],
        ]),
      }),
    );
    const plan = await buildPlan(
      analysis([at(`${gh}a.jar`, { sha512: "aa" }), at(`${gh}b.jar`, { sha1: "bb" })]),
      ctx({ resolve }),
    );
    // blocked entries are still looked up
    expect(resolve).toHaveBeenCalledWith([
      expect.objectContaining({ filename: "a.jar" }),
      expect.objectContaining({ filename: "b.jar" }),
    ]);
    const a = plan.rows.find((r) => r.entry.filename === "a.jar")!;
    expect(a.status).toEqual({ kind: "import" });
    expect(a.download).toEqual({ kind: "ok", via: "modrinth-substitute" });
    // the blocked original is not kept as an alternative
    expect(a.entry.origin).toEqual({
      type: "remote",
      url: "https://cdn.modrinth.com/data/P1/a.jar",
    });
    expect(statusOf(plan, "b.jar").kind).toBe("unresolvable");
    expect(plan.notes).toEqual([
      "1 file on github.com can't be downloaded from a web page (no CORS).",
    ]);
  });

  it("picks the first mirror a page can download", async () => {
    const plan = await buildPlan(
      analysis([
        {
          key: "mods/a.jar",
          filename: "a.jar",
          origin: {
            type: "remote",
            url: "https://github.com/o/r/releases/download/v1/a.jar",
            altUrls: ["https://cdn.modrinth.com/data/x/a.jar"],
            size: 3,
          },
        },
      ]),
      ctx(),
    );
    expect(plan.rows[0].status.kind).toBe("import");
    expect(plan.rows[0].entry.origin).toEqual({
      type: "remote",
      url: "https://cdn.modrinth.com/data/x/a.jar",
      size: 3,
    });
  });

  it("keeps only the mirrors that are not blocked as alternatives", async () => {
    const plan = await buildPlan(
      analysis([
        {
          key: "mods/a.jar",
          filename: "a.jar",
          origin: {
            type: "remote",
            url: "https://files.example/a.jar",
            altUrls: [
              "http://pack/a.jar",
              "https://cdn.modrinth.com/data/x/a.jar",
              "https://github.com/o/r/releases/download/v1/a.jar",
              "https://mirror.example/a.jar",
            ],
          },
        },
      ]),
      ctx(),
    );
    expect(plan.rows[0].download).toEqual({ kind: "ok", via: "known-host" });
    expect(plan.rows[0].entry.origin).toEqual({
      type: "remote",
      url: "https://cdn.modrinth.com/data/x/a.jar",
      altUrls: ["https://files.example/a.jar", "https://mirror.example/a.jar"],
    });
  });

  it("keeps an all-blocked origin as it is (the row is unresolvable)", async () => {
    const urls = ["http://pack/a.jar", "https://github.com/o/r/releases/download/v1/a.jar"];
    const plan = await buildPlan(
      analysis([{ key: "a", filename: "a.jar", origin: { type: "remote", url: urls[0], altUrls: urls.slice(1) } }]),
      ctx(),
    );
    expect(plan.rows[0].status).toEqual({
      kind: "unresolvable",
      reason: "internal host pack (not reachable from a web page)",
    });
  });

  it("drops the pack's blocked URLs behind a Modrinth substitute", async () => {
    const gh = "https://github.com/o/r/releases/download/v1/a.jar";
    const plan = await buildPlan(
      analysis([
        {
          key: "mods/a.jar",
          filename: "a.jar",
          sha512: "aa",
          origin: { type: "remote", url: gh, altUrls: ["http://pack/a.jar"] },
        },
      ]),
      ctx({
        resolve: async () => ({
          resolved: new Map([["mods/a.jar", { projectId: "P1", cdnUrl: "https://cdn.modrinth.com/a.jar" }]]),
        }),
      }),
    );
    expect(plan.rows[0].entry.origin).toEqual({ type: "remote", url: "https://cdn.modrinth.com/a.jar" });
  });

  it("does not substitute a Modrinth URL that is itself blocked", async () => {
    const gh = "https://github.com/o/r/releases/download/v1/a.jar";
    const plan = await buildPlan(
      analysis([at(gh, { sha512: "aa" })]),
      ctx({
        resolve: async () => ({
          resolved: new Map([[gh, { projectId: "P1", cdnUrl: "http://cdn.internal/a.jar" }]]),
        }),
      }),
    );
    expect(plan.rows[0].status.kind).toBe("unresolvable");
    expect(plan.rows[0].entry.origin).toEqual({ type: "remote", url: gh });
  });
});

describe("proposeVersionAction", () => {
  const base = { availableVersions: VERSIONS, selectedBundledVersion: "26.3" };

  it("proposes switching to a bundled version matching the pack", () => {
    expect(proposeVersionAction("26.2.1", base)).toEqual({ kind: "switch", to: "26.2" });
  });

  it("does nothing when already selected or no version is known", () => {
    expect(proposeVersionAction("26.3", base)).toEqual({ kind: "none" });
    expect(proposeVersionAction(undefined, base)).toEqual({ kind: "none" });
  });

  it("does nothing without availableVersions", () => {
    expect(proposeVersionAction("26.2", {})).toEqual({ kind: "none" });
    expect(proposeVersionAction("26.2", { importedClientVersion: "26.1" })).toEqual({ kind: "none" });
    expect(proposeVersionAction("1.7.10", { availableVersions: VERSIONS })).toEqual({
      kind: "note",
      text: "The pack targets Minecraft 1.7.10; there is no bundled data for it",
    });
  });

  it("notes a missing bundled version or an imported client", () => {
    expect(proposeVersionAction("1.7.10", base)).toMatchObject({ kind: "note" });
    expect(
      proposeVersionAction("26.2", { ...base, importedClientVersion: "26.1" }),
    ).toEqual({
      kind: "note",
      text: "Using your imported client (26.1); the pack targets Minecraft 26.2",
    });
  });
});
