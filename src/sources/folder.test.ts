import { describe, expect, it } from "vitest";
import {
  analyzeFolder,
  findModsFolder,
  fromDropzoneFiles,
  fromFileList,
  loaderFromName,
  normalizePath,
  type LocalFile,
} from "./folder";
import { PackImportError } from "../types";

function lf(relativePath: string, contents = ""): LocalFile {
  const name = relativePath.split("/").pop()!;
  return { relativePath, file: new File([contents], name) };
}

const RECHISELED_PW = `name = "Rechiseled"
filename = "rechiseled.jar"
side = "both"

[download]
url = "https://cdn.modrinth.com/data/B0g2vT6l/versions/u535HhZe/rechiseled.jar"
hash-format = "sha512"
hash = "ABCDEF"

[update]
[update.modrinth]
mod-id = "B0g2vT6l"
version = "u535HhZe"
`;

const CLIENT_PW = `name = "Sodium"
filename = "sodium.jar"
side = "client"

[download]
url = "https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar"
hash-format = "sha1"
hash = "1234"

[option]
optional = true
default = false
`;

describe("normalizePath / input builders", () => {
  it("normalizes separators and leading ./ or /", () => {
    expect(normalizePath("./inst/mods/a.jar")).toBe("inst/mods/a.jar");
    expect(normalizePath("/inst/mods/a.jar")).toBe("inst/mods/a.jar");
    expect(normalizePath("inst\\mods\\a.jar")).toBe("inst/mods/a.jar");
  });

  it("fromDropzoneFiles prefers relativePath, then path", () => {
    const a = Object.assign(new File([""], "a.jar"), { relativePath: "/x/mods/a.jar" });
    const b = Object.assign(new File([""], "b.jar"), { path: "./b.jar" });
    expect(fromDropzoneFiles([a, b]).map((f) => f.relativePath)).toEqual([
      "x/mods/a.jar",
      "b.jar",
    ]);
  });

  it("fromFileList uses webkitRelativePath when set", () => {
    const a = new File([""], "a.jar");
    Object.defineProperty(a, "webkitRelativePath", { value: "inst/mods/a.jar" });
    const b = new File([""], "b.jar");
    expect(fromFileList([a, b]).map((f) => f.relativePath)).toEqual([
      "inst/mods/a.jar",
      "b.jar",
    ]);
  });
});

describe("findModsFolder", () => {
  it("finds a Prism instance's .minecraft/mods with its .index and instance files", () => {
    const result = findModsFolder([
      lf("inst/.minecraft/mods/a.jar"),
      lf("inst/.minecraft/mods/.index/a.pw.toml"),
      lf("inst/.minecraft/mods/disabled/x.jar"),
      lf("inst/.minecraft/mods/b.jar.disabled"),
      lf("inst/.minecraft/mods/notes.txt"),
      lf("inst/mmc-pack.json"),
      lf("inst/instance.cfg"),
      lf("inst/.minecraft/config/c.json"),
    ]);
    expect(result.modsFolder).toBe("inst/.minecraft/mods");
    expect(result.jars.map((j) => j.relativePath)).toEqual(["inst/.minecraft/mods/a.jar"]);
    expect(result.metaFiles.map((m) => m.relativePath).sort()).toEqual([
      "inst/.minecraft/mods/.index/a.pw.toml",
      "inst/instance.cfg",
      "inst/mmc-pack.json",
    ]);
  });

  it("finds a CurseForge app instance's mods folder", () => {
    const result = findModsFolder([
      lf("Instances/X/mods/a.jar"),
      lf("Instances/X/minecraftinstance.json"),
    ]);
    expect(result.modsFolder).toBe("Instances/X/mods");
    expect(result.metaFiles.map((m) => m.relativePath)).toEqual([
      "Instances/X/minecraftinstance.json",
    ]);
  });

  it("accepts a plain mods folder and loose JARs", () => {
    expect(findModsFolder([lf("mods/a.jar"), lf("mods/b.jar")]).jars).toHaveLength(2);
    expect(findModsFolder([lf("a.jar")]).modsFolder).toBe("");
    // A chosen folder with another name holding JARs directly
    expect(findModsFolder([lf("myjars/a.jar")]).modsFolder).toBe("myjars");
  });

  it("prefers .minecraft/mods, else the folder with the most JARs, and lists candidates", () => {
    const files = [
      lf("A/mods/a.jar"),
      lf("A/mods/b.jar"),
      lf("B/.minecraft/mods/c.jar"),
      lf("C/mods/d.jar"),
    ];
    const result = findModsFolder(files);
    expect(result.modsFolder).toBe("B/.minecraft/mods");
    expect(result.candidates).toEqual(["B/.minecraft/mods", "A/mods", "C/mods"]);
    expect(findModsFolder(files, "C/mods").modsFolder).toBe("C/mods");
    expect(findModsFolder(files, "nope").modsFolder).toBe("B/.minecraft/mods");
  });

  it("ignores mods folders deeper than 4 levels and other folders", () => {
    expect(() =>
      findModsFolder([lf("a/b/c/d/mods/x.jar"), lf("root/libs/y.jar"), lf("root/z.txt")]),
    ).toThrow(PackImportError);
  });

  it("throws NO_MODS_FOLDER naming the dropped root", () => {
    try {
      findModsFolder([lf("inst/config/a.json"), lf("inst/mods/a.jar.disabled")]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PackImportError);
      expect((e as PackImportError).code).toBe("NO_MODS_FOLDER");
      expect((e as PackImportError).message).toContain("inst");
    }
  });
});

describe("analyzeFolder", () => {
  it("reads Prism .index metadata and the instance version/name/loader", async () => {
    const { manifest, entries } = await analyzeFolder([
      lf("inst/.minecraft/mods/rechiseled.jar"),
      lf("inst/.minecraft/mods/sodium.jar"),
      lf("inst/.minecraft/mods/plain.jar"),
      lf("inst/.minecraft/mods/.index/rechiseled.pw.toml", RECHISELED_PW),
      lf("inst/.minecraft/mods/.index/sodium.pw.toml", CLIENT_PW),
      lf("inst/.minecraft/mods/.index/broken.pw.toml", "not = [toml"),
      lf(
        "inst/mmc-pack.json",
        JSON.stringify({
          components: [
            { uid: "net.minecraft", version: "26.2" },
            { uid: "net.fabricmc.fabric-loader", version: "0.19.5" },
          ],
        }),
      ),
      lf("inst/instance.cfg", "[General]\nname=My Instance\nnotes=\n"),
    ]);

    expect(manifest).toMatchObject({
      kind: "folder",
      name: "My Instance",
      minecraftVersion: "26.2",
      loader: { id: "fabric", version: "0.19.5" },
      modsFolder: "inst/.minecraft/mods",
    });
    const byName = Object.fromEntries(entries.map((e) => [e.filename, e]));
    expect(byName["rechiseled.jar"]).toMatchObject({
      side: "both",
      sha512: "abcdef",
      modrinth: { projectId: "B0g2vT6l", versionId: "u535HhZe" },
      origin: { type: "local", relativePath: "inst/.minecraft/mods/rechiseled.jar" },
    });
    expect(byName["sodium.jar"]).toMatchObject({
      side: "client",
      sha1: "1234",
      optional: true,
    });
    expect(byName["plain.jar"].modrinth).toBeUndefined();
  });

  it("reads a CurseForge instance and names a plain folder after it", async () => {
    const cf = await analyzeFolder([
      lf("Instances/X/mods/a.jar"),
      lf(
        "Instances/X/minecraftinstance.json",
        JSON.stringify({
          name: "CF Instance",
          gameVersion: "1.21.1",
          baseModLoader: { name: "neoforge-21.1.1", minecraftVersion: "1.21.1" },
        }),
      ),
    ]);
    expect(cf.manifest).toMatchObject({
      name: "CF Instance",
      minecraftVersion: "1.21.1",
      loader: { id: "neoforge", version: "21.1.1" },
    });

    const plain = await analyzeFolder([lf("MyPack/mods/a.jar")]);
    expect(plain.manifest.name).toBe("MyPack");
    expect(plain.manifest.minecraftVersion).toBeUndefined();
  });
});

describe("analyzeFolder options", () => {
  const files = [lf("a/mods/x.jar"), lf("b/mods/y.jar"), lf("b/mods/z.jar")];

  it("takes { preferred, fallbackName } or the positional form", async () => {
    const byOptions = await analyzeFolder(files, { preferred: "a/mods" });
    const positional = await analyzeFolder(files, "a/mods");
    expect(byOptions.manifest.modsFolder).toBe("a/mods");
    expect(positional.manifest).toEqual(byOptions.manifest);
    expect((await analyzeFolder(files)).manifest.modsFolder).toBe("b/mods");

    const loose = [lf("x.jar")];
    expect((await analyzeFolder(loose, { fallbackName: "Loose" })).manifest.name).toBe("Loose");
    expect((await analyzeFolder(loose, undefined, "Loose")).manifest.name).toBe("Loose");
    expect((await analyzeFolder(loose)).manifest.name).toBe("Mods folder");
  });
});

describe("loaderFromName", () => {
  it("splits loader and version on the first dash", () => {
    expect(loaderFromName("fabric-0.16.9")).toEqual({ id: "fabric", version: "0.16.9" });
    expect(loaderFromName("forge")).toEqual({ id: "forge", version: undefined });
    expect(loaderFromName("liteloader-1")).toBeUndefined();
    expect(loaderFromName(undefined)).toBeUndefined();
  });
});
