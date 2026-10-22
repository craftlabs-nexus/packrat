import { describe, expect, it } from "vitest";
import { isJarFilename, scanJar } from "./jarScan";
import { makeModJar, makeZipBytes } from "./test/jarFixtures";

async function scan(files: Record<string, string>) {
  const bytes = await makeZipBytes(files);
  return scanJar(bytes.buffer as ArrayBuffer);
}

describe("scanJar", () => {
  it("reports code, item definitions and metadata of a mod", async () => {
    const file = await makeModJar("gears", ["gear"]);
    const result = await scanJar(await file.arrayBuffer());
    expect(result).toMatchObject({
      hasClassFiles: true,
      hasItemDefinitions: true,
      modId: "gears",
      displayName: "gears mod",
      loaders: ["fabric"],
    });
    expect(result.size).toBe(file.size);
  });

  it("flags a JAR without class files", async () => {
    const result = await scan({
      "fabric.mod.json": JSON.stringify({ id: "dp" }),
      "assets/dp/items/x.json": "{}",
    });
    expect(result.hasClassFiles).toBe(false);
    expect(result.hasItemDefinitions).toBe(true);
  });

  it("does not count assets/minecraft item definitions", async () => {
    const result = await scan({
      "fabric.mod.json": JSON.stringify({ id: "armor" }),
      "a/B.class": "",
      "assets/minecraft/items/leather_chestplate.json": "{}",
      "assets/minecraft/models/item/stick.json": "{}",
    });
    expect(result.hasClassFiles).toBe(true);
    expect(result.hasItemDefinitions).toBe(false);
  });

  it("reports item tags (data/<ns>/tags/item/)", async () => {
    const result = await scan({
      "fabric.mod.json": JSON.stringify({ id: "chains" }),
      "a/B.class": "",
      "data/c/tags/item/chains.json": "{}",
      "data/c/tags/block/chains.json": "{}",
    });
    expect(result).toMatchObject({ hasItemDefinitions: false, hasItemTags: true });
    const blockOnly = await scan({
      "a/B.class": "",
      "data/c/tags/block/chains.json": "{}",
    });
    expect(blockOnly.hasItemTags).toBe(false);
  });

  it("counts old-format models/item definitions", async () => {
    const result = await scan({
      "fabric.mod.json": JSON.stringify({ id: "old" }),
      "a/B.class": "",
      "assets/old/models/item/x.json": "{}",
    });
    expect(result.hasItemDefinitions).toBe(true);
  });
});

describe("isJarFilename", () => {
  it.each([
    ["sodium-0.9.1.jar", true],
    ["MOD.JAR", true],
    ["mods/sub/a.jar", true],
    ["a.jar.disabled", false],
    ["a.disabled", false],
    ["a.jar.old", false],
    ["a.jar.bak", false],
    [".hidden.jar", false],
    ["readme.txt", false],
    [".jar", false],
  ])("%s -> %s", (name, expected) => {
    expect(isJarFilename(name)).toBe(expected);
  });
});
