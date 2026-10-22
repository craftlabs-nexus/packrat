import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  curseforgeManifestSchema,
  indexTomlSchema,
  mmcPackSchema,
  mrpackIndexSchema,
  packTomlSchema,
  pwTomlSchema,
  safeRelativePath,
} from "./schemas";

describe("safeRelativePath", () => {
  it.each(["mods/a.jar", "config/x/y.toml", "a..b/c.jar"])("accepts %s", (p) => {
    expect(safeRelativePath.safeParse(p).success).toBe(true);
  });

  it.each([
    "../mods/a.jar",
    "mods/../../etc/passwd",
    "/abs/a.jar",
    "C:/Windows/a.jar",
    "mods\\a.jar",
    "mods/a\0.jar",
    "",
  ])("rejects %s", (p) => {
    expect(safeRelativePath.safeParse(p).success).toBe(false);
  });
});

const MRPACK = {
  formatVersion: 1,
  game: "minecraft",
  versionId: "1.0",
  name: "Test Pack",
  files: [
    {
      path: "mods/a.jar",
      hashes: { sha1: "11", sha512: "aa" },
      env: { client: "required", server: "required" },
      downloads: ["https://cdn.modrinth.com/data/x/versions/y/a.jar"],
      fileSize: 10,
    },
  ],
  dependencies: { minecraft: "26.2", "fabric-loader": "0.19.5" },
};

describe("mrpackIndexSchema", () => {
  it("accepts a valid index and keeps unknown keys", () => {
    const parsed = mrpackIndexSchema.parse({ ...MRPACK, summary: "hi" });
    expect(parsed.files[0].path).toBe("mods/a.jar");
    expect((parsed as Record<string, unknown>).summary).toBe("hi");
  });

  it("rejects a path traversal", () => {
    const bad = { ...MRPACK, files: [{ ...MRPACK.files[0], path: "../evil.jar" }] };
    expect(mrpackIndexSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-minecraft game and bad URLs", () => {
    expect(mrpackIndexSchema.safeParse({ ...MRPACK, game: "terraria" }).success).toBe(false);
    const badUrl = { ...MRPACK, files: [{ ...MRPACK.files[0], downloads: ["not a url"] }] };
    expect(mrpackIndexSchema.safeParse(badUrl).success).toBe(false);
  });
});

describe("curseforgeManifestSchema", () => {
  it("accepts a manifest and defaults overrides", () => {
    const parsed = curseforgeManifestSchema.parse({
      manifestType: "minecraftModpack",
      minecraft: { version: "1.21.1", modLoaders: [{ id: "neoforge-21.1.1", primary: true }] },
      name: "CF Pack",
      files: [{ projectID: 1, fileID: 2, required: true }],
    });
    expect(parsed.overrides).toBe("overrides");
  });

  it("rejects another manifest type", () => {
    expect(
      curseforgeManifestSchema.safeParse({ manifestType: "x", minecraft: { version: "1" }, files: [] })
        .success,
    ).toBe(false);
  });
});

describe("packwiz schemas", () => {
  it("parses a Modrinth .pw.toml", () => {
    const pw = pwTomlSchema.parse(
      parseToml(`name = "Rechiseled"
filename = "rechiseled-1.2.6-fabric-mc26.2.jar"
side = "both"

[download]
url = "https://cdn.modrinth.com/data/B0g2vT6l/versions/u535HhZe/rechiseled-1.2.6-fabric-mc26.2.jar"
hash-format = "sha512"
hash = "b1cc"

[update]
[update.modrinth]
mod-id = "B0g2vT6l"
version = "u535HhZe"
`),
    );
    expect(pw.update?.modrinth?.["mod-id"]).toBe("B0g2vT6l");
    expect(pw.download.url).toMatch(/^https:/);
  });

  it("parses a CurseForge-mode .pw.toml and defaults side", () => {
    const pw = pwTomlSchema.parse(
      parseToml(`name = "Cupboard"
filename = "cupboard.jar"

[download]
hash-format = "sha1"
hash = "2657"
mode = "metadata:curseforge"

[update]
[update.curseforge]
file-id = 8888959
project-id = 326652
`),
    );
    expect(pw.side).toBe("both");
    expect(pw.download.url).toBeUndefined();
    expect(pw.update?.curseforge?.["project-id"]).toBe(326652);
  });

  it("parses pack.toml and index.toml", () => {
    const pack = packTomlSchema.parse(
      parseToml(`name = "P"
[index]
file = "index.toml"
hash-format = "sha256"
[versions]
minecraft = "26.2"
fabric = "0.19.5"
`),
    );
    expect(pack.versions?.minecraft).toBe("26.2");
    const index = indexTomlSchema.parse(
      parseToml(`hash-format = "sha256"
[[files]]
file = "mods/a.pw.toml"
metafile = true
`),
    );
    expect(index.files).toHaveLength(1);
    expect(indexTomlSchema.parse({}).files).toEqual([]);
  });

  it("rejects a .pw.toml without filename", () => {
    expect(pwTomlSchema.safeParse({ download: {} }).success).toBe(false);
  });
});

describe("mmcPackSchema", () => {
  it("parses components", () => {
    const parsed = mmcPackSchema.parse({
      components: [{ uid: "net.minecraft", version: "26.2" }, { uid: "net.fabricmc.fabric-loader" }],
      formatVersion: 1,
    });
    expect(parsed.components[0].version).toBe("26.2");
  });
});
