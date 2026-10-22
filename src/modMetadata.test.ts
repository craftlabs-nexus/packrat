import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractModMetadata, isModJar, loadIconFromJar } from "./modMetadata";
import { makeZipBytes } from "./test/jarFixtures";

async function zipOf(files: Record<string, string | Uint8Array>): Promise<JSZip> {
  return JSZip.loadAsync(await makeZipBytes(files));
}

const MODS_TOML = `modLoader = "javafml"
loaderVersion = "[47,)"
logoFile = "logo.png"

[[mods]]
modId = "gears"
version = "2.1.0"
displayName = "Gears"

[[dependencies.gears]]
modId = "forge"
versionRange = "[47,)"

[[dependencies.gears]]
modId = "minecraft"
versionRange = "[1.20.1,1.21)"
`;

describe("extractModMetadata", () => {
  it("reads Fabric metadata, joining an array of Minecraft versions", async () => {
    const meta = await extractModMetadata(
      await zipOf({
        "fabric.mod.json": JSON.stringify({
          id: "fab",
          name: "Fab",
          version: "1.0.0",
          icon: "assets/fab/icon.png",
          depends: { minecraft: [">=26.1", "26.2.x"] },
        }),
      }),
    );
    expect(meta).toEqual({
      loaders: ["fabric"],
      modId: "fab",
      displayName: "Fab",
      version: "1.0.0",
      iconPath: "assets/fab/icon.png",
      minecraftVersions: ">=26.1, 26.2.x",
    });
  });

  it("ignores fields of the wrong type (an icon map, an object version)", async () => {
    const meta = await extractModMetadata(
      await zipOf({
        "fabric.mod.json": JSON.stringify({ id: 7, icon: { 16: "a.png" }, depends: { minecraft: { x: 1 } } }),
      }),
    );
    expect(meta).toEqual({ loaders: ["fabric"] });
  });

  it("reads Quilt metadata", async () => {
    const meta = await extractModMetadata(
      await zipOf({
        "quilt.mod.json": JSON.stringify({
          quilt_loader: {
            id: "quilty",
            version: "0.3.0",
            metadata: { name: "Quilty", icon: "icon.png" },
            depends: ["quilt_base", { id: "minecraft", versions: "~26.2" }],
          },
        }),
      }),
    );
    expect(meta).toEqual({
      loaders: ["quilt"],
      modId: "quilty",
      displayName: "Quilty",
      version: "0.3.0",
      iconPath: "icon.png",
      minecraftVersions: "~26.2",
    });
  });

  it("reads Forge and NeoForge mods.toml", async () => {
    const expected = {
      modId: "gears",
      displayName: "Gears",
      version: "2.1.0",
      iconPath: "logo.png",
      minecraftVersions: "[1.20.1,1.21)",
    };
    expect(await extractModMetadata(await zipOf({ "META-INF/mods.toml": MODS_TOML }))).toEqual({
      loaders: ["forge"],
      ...expected,
    });
    expect(await extractModMetadata(await zipOf({ "META-INF/neoforge.mods.toml": MODS_TOML }))).toEqual({
      loaders: ["neoforge"],
      ...expected,
    });
  });

  it("prefers Fabric over the others and lists every loader", async () => {
    const meta = await extractModMetadata(
      await zipOf({
        "META-INF/neoforge.mods.toml": MODS_TOML,
        "fabric.mod.json": JSON.stringify({ id: "fab" }),
      }),
    );
    expect(meta.loaders).toEqual(["fabric", "neoforge"]);
    expect(meta).toMatchObject({ modId: "fab", displayName: "Gears" });
  });

  it("counts a legacy mcmod.info as Forge, and skips unparseable files", async () => {
    const meta = await extractModMetadata(
      await zipOf({ "mcmod.info": "[]", "fabric.mod.json": "{ not json" }),
    );
    expect(meta).toEqual({ loaders: ["forge"] });
  });
});

describe("isModJar", () => {
  it("is true for any loader's metadata file", async () => {
    for (const path of ["fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "mcmod.info"]) {
      expect(isModJar(await zipOf({ [path]: "{}" })), path).toBe(true);
    }
    expect(isModJar(await zipOf({ "pack.mcmeta": "{}" }))).toBe(false);
  });
});

describe("loadIconFromJar", () => {
  it("returns a data URL typed by extension, undefined when missing", async () => {
    const zip = await zipOf({
      "icon.png": new Uint8Array([1, 2, 3]),
      "icon.JPG": new Uint8Array([4]),
      "icon.webp": new Uint8Array([5]),
    });
    expect(await loadIconFromJar(zip, "icon.png")).toBe("data:image/png;base64,AQID");
    expect(await loadIconFromJar(zip, "icon.JPG")).toBe("data:image/jpeg;base64,BA==");
    expect(await loadIconFromJar(zip, "icon.webp")).toBe("data:image/png;base64,BQ==");
    expect(await loadIconFromJar(zip, "missing.png")).toBeUndefined();
  });
});
