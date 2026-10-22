import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPlan } from "./plan";
import {
  HASH_BATCH_SIZE,
  resolveModrinth,
  type ResolveDeps,
} from "./modrinthResolve";

function version(id: string, projectId: string) {
  return { id, project_id: projectId, files: [] };
}

function project(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    slug: `slug-${id}`,
    title: `Title ${id}`,
    icon_url: `https://cdn/${id}.png`,
    client_side: "required",
    server_side: "required",
    ...overrides,
  };
}

describe("resolveModrinth", () => {
  it("resolves hashes to versions and projects, skipping unknown hashes", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async () => ({ aa: version("V1", "P1") })),
      getProjects: vi.fn(async () => [project("P1", { server_side: "unsupported" })]),
    };

    const { resolved, warning } = await resolveModrinth(
      [
        { key: "a", sha512: "AA" },
        { key: "b", sha512: "bb" },
      ],
      deps,
    );

    expect(warning).toBeUndefined();
    expect(deps.getVersionsFromHashes).toHaveBeenCalledWith(["aa", "bb"], "sha512");
    expect(resolved.get("a")).toEqual({
      projectId: "P1",
      versionId: "V1",
      project: {
        id: "P1",
        title: "Title P1",
        iconUrl: "https://cdn/P1.png",
        clientSide: "required",
        serverSide: "unsupported",
      },
    });
    expect(resolved.has("b")).toBe(false);
  });

  it("uses ids already in the pack and accepts a slug as mod-id", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async () => ({})),
      getProjects: vi.fn(async () => [project("P9")]),
    };
    const { resolved } = await resolveModrinth(
      [{ key: "a", sha512: "aa", modrinth: { projectId: "slug-P9", versionId: "V9" } }],
      deps,
    );
    expect(deps.getVersionsFromHashes).not.toHaveBeenCalled();
    expect(resolved.get("a")?.projectId).toBe("P9");
    expect(resolved.get("a")?.project?.title).toBe("Title P9");
  });

  it("falls back to sha1 lookups for entries without sha512", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async (_h: string[], algo: string) =>
        algo === "sha1" ? { "11": version("V2", "P2") } : {},
      ),
      getProjects: vi.fn(async () => []),
    };
    const { resolved } = await resolveModrinth([{ key: "a", sha1: "11" }], deps);
    expect(resolved.get("a")).toEqual({ projectId: "P2", versionId: "V2" });
  });

  it("keeps Modrinth's file URL only for a file whose sha512 matches", async () => {
    const file = (sha512: string, url: string) => ({
      hashes: { sha512, sha1: "11" },
      url,
      filename: "a.jar",
    });
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async (_h: string[], algo: string) =>
        algo === "sha512"
          ? {
              aa: { ...version("V1", "P1"), files: [file("other", "https://cdn/x.jar"), file("AA", "https://cdn/a.jar")] },
              bb: { ...version("V2", "P2"), files: [file("other", "https://cdn/y.jar")] },
            }
          : { "11": { ...version("V3", "P3"), files: [file("cc", "https://cdn/c.jar")] } },
      ),
      getProjects: vi.fn(async () => []),
    };
    const { resolved } = await resolveModrinth(
      [
        { key: "a", sha512: "aa" },
        { key: "b", sha512: "bb" },
        { key: "c", sha1: "11" },
      ],
      deps,
    );
    expect(resolved.get("a")).toEqual({ projectId: "P1", versionId: "V1", cdnUrl: "https://cdn/a.jar" });
    expect(resolved.get("b")).toEqual({ projectId: "P2", versionId: "V2" });
    // sha1-only: no substitute (the runner could not verify the bytes by sha512)
    expect(resolved.get("c")).toEqual({ projectId: "P3", versionId: "V3" });
  });

  it("batches hash lookups", async () => {
    const calls: number[] = [];
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async (hashes: string[]) => {
        calls.push(hashes.length);
        return {};
      }),
      getProjects: vi.fn(async () => []),
    };
    const entries = Array.from({ length: HASH_BATCH_SIZE + 5 }, (_, i) => ({
      key: `k${i}`,
      sha512: `h${i}`,
    }));
    await resolveModrinth(entries, deps);
    expect(calls).toEqual([HASH_BATCH_SIZE, 5]);
  });

  it("tolerates failures and returns a warning with what it resolved", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      getProjects: vi.fn(async () => {
        throw new Error("Modrinth API error: 500");
      }),
    };
    const { resolved, warning } = await resolveModrinth(
      [
        { key: "a", sha512: "aa" },
        { key: "b", modrinth: { projectId: "P1" } },
      ],
      deps,
    );
    expect(warning).toMatch(/Modrinth lookup failed: Failed to fetch/);
    expect(resolved.get("b")).toEqual({ projectId: "P1", versionId: undefined });
    expect(resolved.has("a")).toBe(false);
  });

  it("drops malformed responses", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async () => ({ aa: { nope: true } })),
      getProjects: vi.fn(async () => [{ id: 1 }]),
    };
    const { resolved } = await resolveModrinth([{ key: "a", sha512: "aa" }], deps);
    expect(resolved.size).toBe(0);
  });

  it("takes { deps } as well as bare deps", async () => {
    const deps: ResolveDeps = {
      getVersionsFromHashes: vi.fn(async () => ({ aa: version("V1", "P1") })),
      getProjects: vi.fn(async () => []),
    };
    const { resolved } = await resolveModrinth([{ key: "a", sha512: "aa" }], { deps });
    expect(resolved.get("a")?.projectId).toBe("P1");
  });
});

describe("Modrinth client config", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubModrinth() {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      Response.json(url.endsWith("/version_files") ? { aa: version("V1", "P1") } : [project("P1")]),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reaches the Modrinth calls from resolveModrinth and buildPlan", async () => {
    const config = { userAgent: "craftlabs/blockscope/1.0", baseUrl: "https://api.test/v2" };
    const fetchMock = stubModrinth();
    const { resolved } = await resolveModrinth([{ key: "a", sha512: "aa" }], { config });
    expect(resolved.get("a")?.project?.title).toBe("Title P1");
    expect(fetchMock.mock.calls.map((c) => [String(c[0]).split("?")[0], (c[1] as RequestInit).headers])).toEqual([
      ["https://api.test/v2/version_files", expect.objectContaining({ "User-Agent": config.userAgent })],
      ["https://api.test/v2/projects", expect.objectContaining({ "User-Agent": config.userAgent })],
    ]);

    fetchMock.mockClear();
    await buildPlan(
      {
        manifest: { kind: "mrpack" },
        entries: [{ key: "a", filename: "a.jar", sha512: "aa", origin: { type: "remote", url: "https://cdn.modrinth.com/a.jar" } }],
      },
      { modrinth: config },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.test/v2/version_files");
  });
});
