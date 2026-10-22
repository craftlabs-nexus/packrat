/**
 * Modrinth modpack (.mrpack): modrinth.index.json lists downloadable files
 * (Modrinth CDN URLs with hashes and client/server env); overrides/,
 * server-overrides/ and client-overrides/ hold bundled files.
 */
import type JSZip from "jszip";
import { z } from "zod";
import { isJarFilename } from "../jarScan";
import {
  describeZodError,
  mrpackFileSchema,
  mrpackIndexSchema,
} from "../schemas";
import {
  PackImportError,
  type PackAnalysis,
  type PackEntry,
  type PackLoaderId,
  type PackSide,
} from "../types";
import { basename } from "../utils";
import { loadPackZip, overrideJarEntries, readZipJson } from "./zip";

/** The index with files checked one by one (a bad entry doesn't sink the pack). */
const indexWithLooseFiles = mrpackIndexSchema.extend({
  files: z.array(z.unknown()),
});

const LOADER_DEPENDENCIES: Record<string, PackLoaderId> = {
  "fabric-loader": "fabric",
  "quilt-loader": "quilt",
  neoforge: "neoforge",
  forge: "forge",
};

export function sideFromEnv(
  env: { client: string; server: string } | undefined,
): PackSide {
  if (env?.server === "unsupported") return "client";
  if (env?.client === "unsupported") return "server";
  return "both";
}

export async function analyzeMrpack(file: File): Promise<PackAnalysis> {
  return analyzeMrpackZip(await loadPackZip(file, file.name), file.name);
}

/** analyzeMrpack on a zip already loaded (`label`: its file name). */
export async function analyzeMrpackZip(zip: JSZip, label: string): Promise<PackAnalysis> {
  const raw = await readZipJson(zip, "modrinth.index.json");
  if (raw === undefined) {
    throw new PackImportError(
      "INVALID_PACK",
      `${label} is not a Modrinth pack: modrinth.index.json is missing`,
    );
  }
  const parsed = indexWithLooseFiles.safeParse(raw);
  if (!parsed.success) {
    throw new PackImportError(
      "INVALID_PACK",
      `Invalid modrinth.index.json: ${describeZodError(parsed.error)}`,
    );
  }
  const index = parsed.data;
  const notes: string[] = [];

  const entries: PackEntry[] = [];
  let invalid = 0;
  for (const rawFile of index.files) {
    const f = mrpackFileSchema.safeParse(rawFile);
    if (!f.success) {
      invalid++;
      continue;
    }
    const { path, hashes, env, downloads, fileSize } = f.data;
    const filename = basename(path);
    if (path !== `mods/${filename}` || !isJarFilename(filename)) continue;
    const entry: PackEntry = {
      key: path,
      filename,
      side: sideFromEnv(env),
      sha512: hashes.sha512?.toLowerCase(),
      sha1: hashes.sha1?.toLowerCase(),
    };
    if (downloads.length > 0) {
      // Every listed mirror: the plan picks one a web page can download
      entry.origin = {
        type: "remote",
        url: downloads[0],
        ...(downloads.length > 1 ? { altUrls: downloads.slice(1) } : {}),
        size: fileSize,
      };
    } else {
      entry.unresolvable = "no download URL";
    }
    entries.push(entry);
  }
  if (invalid > 0) {
    notes.push(
      `${invalid} file${invalid > 1 ? "s" : ""} in modrinth.index.json had an invalid or unsafe entry and ${invalid > 1 ? "were" : "was"} ignored`,
    );
  }

  entries.push(
    ...(await overrideJarEntries(zip, "overrides", "both")),
    ...(await overrideJarEntries(zip, "server-overrides", "both")),
    ...(await overrideJarEntries(zip, "client-overrides", "client")),
  );

  let loader: PackAnalysis["manifest"]["loader"];
  for (const [dep, id] of Object.entries(LOADER_DEPENDENCIES)) {
    const version = index.dependencies[dep];
    if (version) {
      loader = { id, version };
      break;
    }
  }

  return {
    manifest: {
      kind: "mrpack",
      name: index.name,
      minecraftVersion: index.dependencies.minecraft,
      loader,
    },
    entries,
    notes,
  };
}
