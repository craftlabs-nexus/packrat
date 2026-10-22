/**
 * Shared helpers for pack zips (.mrpack, CurseForge zip, zipped mods folder).
 */
import JSZip from "jszip";
import { getErrorMessage } from "../utils";
import { isJarFilename } from "../jarScan";
import { PackImportError, type PackEntry, type PackSide } from "../types";

export async function loadPackZip(file: Blob, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(await file.arrayBuffer());
  } catch (e) {
    throw new PackImportError(
      "INVALID_PACK",
      `Could not read ${label} as a zip: ${getErrorMessage(e)}`,
    );
  }
}

/** Parse a JSON file from the zip; undefined when it is missing. */
export async function readZipJson(
  zip: JSZip,
  path: string,
): Promise<unknown | undefined> {
  const entry = zip.file(path);
  if (!entry) return undefined;
  const text = await entry.async("string");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PackImportError(
      "INVALID_PACK",
      `${path} is not valid JSON: ${getErrorMessage(e)}`,
    );
  }
}

/**
 * Local entries for the JARs directly inside `<folder>/mods/` of a zip
 * (e.g. overrides/mods/*.jar), extracted to Files.
 */
export async function overrideJarEntries(
  zip: JSZip,
  folder: string,
  side: PackSide,
): Promise<PackEntry[]> {
  const prefix = `${folder}/mods/`;
  const entries: PackEntry[] = [];
  for (const path of Object.keys(zip.files).sort()) {
    const entry = zip.files[path];
    if (entry.dir || !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes("/") || !isJarFilename(rest)) continue;
    const bytes = await entry.async("uint8array");
    const file = new File([bytes as Uint8Array<ArrayBuffer>], rest, {
      type: "application/java-archive",
    });
    entries.push({
      key: path,
      filename: rest,
      side,
      origin: { type: "local", file, relativePath: path },
    });
  }
  return entries;
}
