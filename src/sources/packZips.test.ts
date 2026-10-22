import { describe, expect, it } from "vitest";
import { analyzeMrpack, sideFromEnv } from "./mrpack";
import { analyzeCurseforgeZip, CURSEFORGE_UNRESOLVABLE } from "./curseforge";
import { analyzeModsZip, analyzePackZip, detectPackZip } from "./detect";
import { PackImportError } from "../types";
import { makeModJar, makeZipBytes, makeZipFile } from "../test/jarFixtures";

async function jarBytes(modId: string): Promise<Uint8Array> {
  return new Uint8Array(await (await makeModJar(modId)).arrayBuffer());
}

function mrFile(path: string, extra: Record<string, unknown> = {}) {
  return {
    path,
    hashes: { sha1: "AB", sha512: "CD" },
    env: { client: "required", server: "required" },
    downloads: [`https://cdn.modrinth.com/data/x/${path}`],
    fileSize: 123,
    ...extra,
  };
}

async function mrpack(files: unknown[], extra: Record<string, Uint8Array | string> = {}) {
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.2.3",
    name: "Test Pack",
    files,
    dependencies: { minecraft: "26.2", "fabric-loader": "0.19.5" },
  };
  return makeZipFile({ "modrinth.index.json": JSON.stringify(index), ...extra }, "test.mrpack");
}

describe("analyzeMrpack", () => {
  it("lists remote mods with hashes and sides, plus override JARs", async () => {
    const pack = await mrpack(
      [
        mrFile("mods/both.jar"),
        mrFile("mods/client.jar", { env: { client: "required", server: "unsupported" } }),
        mrFile("mods/server.jar", { env: { client: "unsupported", server: "required" } }),
        mrFile("mods/nodl.jar", { downloads: [] }),
        mrFile("mods/mirrors.jar", {
          downloads: ["https://github.com/o/r/releases/download/v1/m.jar", "https://cdn.modrinth.com/m.jar"],
        }),
        mrFile("resourcepacks/rp.zip"),
        mrFile("mods/sub/nested.jar"),
      ],
      {
        "overrides/mods/local.jar": await jarBytes("local"),
        "overrides/config/x.toml": "a = 1",
        "client-overrides/mods/clientlocal.jar": await jarBytes("clientlocal"),
        "server-overrides/mods/serverlocal.jar": await jarBytes("serverlocal"),
      },
    );

    const { manifest, entries, notes } = await analyzeMrpack(pack);

    expect(manifest).toEqual({
      kind: "mrpack",
      name: "Test Pack",
      minecraftVersion: "26.2",
      loader: { id: "fabric", version: "0.19.5" },
    });
    expect(notes).toEqual([]);
    const byName = Object.fromEntries(entries.map((e) => [e.filename, e]));
    expect(Object.keys(byName).sort()).toEqual([
      "both.jar",
      "client.jar",
      "clientlocal.jar",
      "local.jar",
      "mirrors.jar",
      "nodl.jar",
      "server.jar",
      "serverlocal.jar",
    ]);
    expect(byName["both.jar"]).toMatchObject({
      side: "both",
      sha1: "ab",
      sha512: "cd",
      origin: { type: "remote", url: "https://cdn.modrinth.com/data/x/mods/both.jar", size: 123 },
    });
    expect(byName["both.jar"].origin).not.toHaveProperty("altUrls");
    expect(byName["mirrors.jar"].origin).toEqual({
      type: "remote",
      url: "https://github.com/o/r/releases/download/v1/m.jar",
      altUrls: ["https://cdn.modrinth.com/m.jar"],
      size: 123,
    });
    expect(byName["client.jar"].side).toBe("client");
    expect(byName["server.jar"].side).toBe("server");
    expect(byName["nodl.jar"]).toMatchObject({ unresolvable: "no download URL" });
    expect(byName["nodl.jar"].origin).toBeUndefined();
    expect(byName["local.jar"]).toMatchObject({ side: "both", origin: { type: "local" } });
    expect(byName["clientlocal.jar"].side).toBe("client");
    expect(byName["serverlocal.jar"].side).toBe("both");

    const local = byName["local.jar"].origin;
    expect(local?.type === "local" && local.file.size).toBeGreaterThan(0);
  });

  it("ignores entries with unsafe paths and says so", async () => {
    const pack = await mrpack([mrFile("../evil.jar"), mrFile("mods/ok.jar")]);
    const { entries, notes } = await analyzeMrpack(pack);
    expect(entries.map((e) => e.filename)).toEqual(["ok.jar"]);
    expect(notes?.[0]).toMatch(/1 file .* ignored/);
  });

  it("rejects a zip without an index or with an invalid one", async () => {
    await expect(analyzeMrpack(await makeZipFile({ "x.txt": "" }, "a.mrpack"))).rejects.toMatchObject({
      code: "INVALID_PACK",
    });
    const bad = await makeZipFile({ "modrinth.index.json": JSON.stringify({ game: "minecraft" }) }, "b.mrpack");
    await expect(analyzeMrpack(bad)).rejects.toThrow(/Invalid modrinth.index.json/);
    const notJson = await makeZipFile({ "modrinth.index.json": "{" }, "c.mrpack");
    await expect(analyzeMrpack(notJson)).rejects.toThrow(/not valid JSON/);
    await expect(analyzeMrpack(new File(["nope"], "d.mrpack"))).rejects.toBeInstanceOf(PackImportError);
  });

  it("maps env to side", () => {
    expect(sideFromEnv(undefined)).toBe("both");
    expect(sideFromEnv({ client: "optional", server: "unsupported" })).toBe("client");
    expect(sideFromEnv({ client: "unsupported", server: "optional" })).toBe("server");
  });
});

describe("analyzeCurseforgeZip", () => {
  it("imports override JARs and lists manifest files as unresolvable with one note", async () => {
    const zip = await makeZipFile(
      {
        "manifest.json": JSON.stringify({
          manifestType: "minecraftModpack",
          manifestVersion: 1,
          name: "CF Pack",
          minecraft: {
            version: "1.21.1",
            modLoaders: [
              { id: "forge-1", primary: false },
              { id: "neoforge-21.1.77", primary: true },
            ],
          },
          files: [
            { projectID: 1, fileID: 10, required: true },
            { projectID: 2, fileID: 20, required: false },
          ],
          overrides: "overrides",
        }),
        "overrides/mods/bundled.jar": await jarBytes("bundled"),
      },
      "cf.zip",
    );

    const { manifest, entries, notes } = await analyzeCurseforgeZip(zip);

    expect(manifest).toEqual({
      kind: "curseforge",
      name: "CF Pack",
      minecraftVersion: "1.21.1",
      loader: { id: "neoforge", version: "21.1.77" },
    });
    expect(entries.map((e) => e.filename)).toEqual([
      "bundled.jar",
      "CurseForge project 1 file 10",
      "CurseForge project 2 file 20",
    ]);
    expect(entries[1]).toMatchObject({
      key: "curseforge:1:10",
      curseforge: { projectId: 1, fileId: 10 },
      unresolvable: CURSEFORGE_UNRESOLVABLE,
    });
    expect(entries[2].optional).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes?.[0]).toMatch(/^2 mods listed in manifest.json/);
  });

  it("rejects an invalid manifest", async () => {
    const zip = await makeZipFile({ "manifest.json": JSON.stringify({ manifestType: "x" }) }, "cf.zip");
    await expect(analyzeCurseforgeZip(zip)).rejects.toMatchObject({ code: "INVALID_PACK" });
  });
});

describe("detectPackZip / analyzePackZip", () => {
  it("detects by extension, index file, manifest or mods folder", async () => {
    expect(await detectPackZip(new File(["x"], "pack.MRPACK"))).toBe("mrpack");
    expect(await detectPackZip(await makeZipFile({ "modrinth.index.json": "{}" }, "p.zip"))).toBe("mrpack");
    expect(await detectPackZip(await makeZipFile({ "manifest.json": "{}" }, "p.zip"))).toBe("curseforge");
    expect(await detectPackZip(await makeZipFile({ "inst/mods/a.jar": "" }, "p.zip"))).toBe("mods-zip");
    expect(await detectPackZip(await makeZipFile({ "readme.txt": "" }, "p.zip"))).toBeNull();
    expect(await detectPackZip(new File(["not a zip"], "p.zip"))).toBeNull();
  });

  it("analyzes a zipped instance, extracting only the chosen mods folder", async () => {
    const zip = new File(
      [
        (await makeZipBytes({
          "inst/.minecraft/mods/a.jar": await jarBytes("a"),
          "inst/.minecraft/mods/disabled/b.jar": await jarBytes("b"),
          "inst/mmc-pack.json": JSON.stringify({ components: [{ uid: "net.minecraft", version: "26.2" }] }),
          "other/mods/c.jar": await jarBytes("c"),
        })) as Uint8Array<ArrayBuffer>,
      ],
      "MyInstance.zip",
    );

    const { manifest, entries } = await analyzeModsZip(zip);
    expect(manifest).toMatchObject({
      kind: "folder",
      name: "inst",
      minecraftVersion: "26.2",
      modsFolder: "inst/.minecraft/mods",
      modsFolderCandidates: ["inst/.minecraft/mods", "other/mods"],
    });
    expect(entries.map((e) => e.filename)).toEqual(["a.jar"]);

    const other = await analyzeModsZip(zip, "other/mods");
    expect(other.entries.map((e) => e.filename)).toEqual(["c.jar"]);
  });

  it("names a zipped bare mods folder after the zip", async () => {
    const zip = await makeZipFile({ "mods/a.jar": await jarBytes("a") }, "Server Mods.zip");
    expect((await analyzePackZip(zip)).manifest.name).toBe("Server Mods");
  });

  it("rejects an unrecognized zip", async () => {
    const zip = await makeZipFile({ "readme.txt": "" }, "x.zip");
    await expect(analyzePackZip(zip)).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT" });
  });
});
