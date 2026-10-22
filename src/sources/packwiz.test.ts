// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzePackwiz, validatePackUrl } from "./packwiz";
import { PackImportError } from "../types";

const BASE = "https://example.com/pack";

const FILES: Record<string, string> = {
  [`${BASE}/craftlabs/pack.toml`]: `name = "CraftLabs"
pack-format = "packwiz:1.1.0"

[index]
file = "index.toml"
hash-format = "sha256"
hash = "x"

[versions]
fabric = "0.19.5"
minecraft = "26.2"
`,
  [`${BASE}/craftlabs/index.toml`]: `hash-format = "sha512"

[[files]]
file = "mods/rechiseled.pw.toml"
hash = "a"
metafile = true

[[files]]
file = "mods/sodium.pw.toml"
metafile = true

[[files]]
file = "mods/cupboard.pw.toml"
metafile = true

[[files]]
file = "mods/opt.pw.toml"
metafile = true

[[files]]
file = "mods/missing.pw.toml"
metafile = true

[[files]]
file = "mods/local-only.jar"
hash = "ABCD"

[[files]]
file = "resourcepacks/rp.pw.toml"
metafile = true

[[files]]
file = "config/x.toml"
`,
  [`${BASE}/craftlabs/mods/rechiseled.pw.toml`]: `name = "Rechiseled"
filename = "rechiseled-1.2.6.jar"
side = "both"

[download]
url = "https://cdn.modrinth.com/data/B0g2vT6l/versions/u535HhZe/rechiseled-1.2.6.jar"
hash-format = "sha512"
hash = "B1CC"

[update]
[update.modrinth]
mod-id = "B0g2vT6l"
version = "u535HhZe"
`,
  [`${BASE}/craftlabs/mods/sodium.pw.toml`]: `name = "Sodium"
filename = "sodium.jar"
side = "client"

[download]
url = "https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar"
hash-format = "sha1"
hash = "11"
`,
  [`${BASE}/craftlabs/mods/cupboard.pw.toml`]: `name = "Cupboard"
filename = "cupboard.jar"
side = "server"

[download]
hash-format = "sha1"
hash = "2657"
mode = "metadata:curseforge"

[update]
[update.curseforge]
file-id = 8888959
project-id = 326652
`,
  [`${BASE}/craftlabs/mods/opt.pw.toml`]: `filename = "opt.jar"

[download]
url = "https://cdn.modrinth.com/data/o/versions/o/opt.jar"

[option]
optional = true
default = false
`,
};

function stubFetch(files: Record<string, string>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    const body = files[url];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(body, { status: 200 });
  });
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzePackwiz", () => {
  it("resolves the index and metafiles relative to their files", async () => {
    const { fetchMock, calls } = stubFetch(FILES);
    vi.stubGlobal("fetch", fetchMock);

    const { manifest, entries } = await analyzePackwiz(`${BASE}/craftlabs/pack.toml`);

    expect(manifest).toEqual({
      kind: "packwiz",
      name: "CraftLabs",
      minecraftVersion: "26.2",
      loader: { id: "fabric", version: "0.19.5" },
      packOrigin: "https://example.com",
    });
    expect(calls).not.toContain(`${BASE}/craftlabs/resourcepacks/rp.pw.toml`);

    const byName = Object.fromEntries(entries.map((e) => [e.filename, e]));
    expect(byName["rechiseled-1.2.6.jar"]).toMatchObject({
      key: `${BASE}/craftlabs/mods/rechiseled.pw.toml`,
      side: "both",
      sha512: "b1cc",
      modrinth: { projectId: "B0g2vT6l", versionId: "u535HhZe" },
      origin: {
        type: "remote",
        url: "https://cdn.modrinth.com/data/B0g2vT6l/versions/u535HhZe/rechiseled-1.2.6.jar",
      },
    });
    expect(byName["sodium.jar"]).toMatchObject({ side: "client", sha1: "11" });
    expect(byName["cupboard.jar"]).toMatchObject({
      side: "server",
      curseforge: { projectId: 326652, fileId: 8888959 },
      unresolvable: "CurseForge-hosted (not downloadable in the browser)",
    });
    expect(byName["cupboard.jar"].origin).toBeUndefined();
    expect(byName["opt.jar"]).toMatchObject({ optional: true, side: "both" });
    expect(byName["missing"]).toMatchObject({ unresolvable: expect.stringMatching(/^404 fetching/) });
    expect(byName["local-only.jar"]).toMatchObject({
      sha512: "abcd",
      origin: { type: "remote", url: `${BASE}/craftlabs/mods/local-only.jar` },
    });
  });

  it("reports CORS/network failures clearly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(analyzePackwiz(`${BASE}/pack.toml`)).rejects.toMatchObject({
      code: "FETCH_FAILED",
      message: expect.stringMatching(/cross-origin requests \(CORS\)/),
    });
  });

  it("reports HTTP errors and a missing index", async () => {
    const { fetchMock } = stubFetch({ [`${BASE}/pack.toml`]: FILES[`${BASE}/craftlabs/pack.toml`] });
    vi.stubGlobal("fetch", fetchMock);
    await expect(analyzePackwiz(`${BASE}/nope.toml`)).rejects.toThrow(`404 fetching ${BASE}/nope.toml`);
    await expect(analyzePackwiz(`${BASE}/pack.toml`)).rejects.toThrow(`404 fetching ${BASE}/index.toml`);
  });

  it("rejects invalid TOML and invalid pack.toml", async () => {
    vi.stubGlobal("fetch", stubFetch({ [`${BASE}/a.toml`]: "x = [", [`${BASE}/b.toml`]: 'name = "x"' }).fetchMock);
    await expect(analyzePackwiz(`${BASE}/a.toml`)).rejects.toMatchObject({ code: "INVALID_PACK" });
    await expect(analyzePackwiz(`${BASE}/b.toml`)).rejects.toThrow(/Invalid pack.toml/);
  });
});

describe("validatePackUrl", () => {
  it("accepts https and local http", () => {
    expect(validatePackUrl(" https://a.example/pack.toml ").href).toBe("https://a.example/pack.toml");
    expect(validatePackUrl("http://localhost:8123/pack.toml").port).toBe("8123");
    expect(validatePackUrl("http://127.0.0.1/pack.toml").hostname).toBe("127.0.0.1");
  });

  it("accepts http on an http page (dev server)", () => {
    expect(validatePackUrl("http://192.168.1.24/pack.toml", "http:").hostname).toBe("192.168.1.24");
  });

  it("rejects other schemes, credentials and non-URLs", () => {
    expect(() => validatePackUrl("http://example.com/pack.toml")).toThrow(PackImportError);
    expect(() => validatePackUrl("http://example.com/pack.toml", "https:")).toThrow(/https/);
    expect(() => validatePackUrl("https://u:p@example.com/pack.toml")).toThrow(/user name or password/);
    expect(() => validatePackUrl("file:///C:/pack.toml")).toThrow(/https/);
    expect(() => validatePackUrl("pack.toml")).toThrow(/full URL/);
  });
});
