/**
 * Cheap JAR scan for the review step: JSZip reads only the central directory
 * up front (entries are inflated lazily), so listing names costs no
 * decompression; only the small mod metadata file is inflated.
 */
import JSZip from "jszip";
import { extractModMetadata } from "./modMetadata";
import { basename } from "./utils";
import type { LocalJarScan } from "./types";

const CLASS_FILE = /\.class$/;
/** Item definitions of a namespace other than minecraft (mods never own minecraft: items). */
const ITEM_DEFINITION =
  /^assets\/(?!minecraft\/)[a-z0-9_.-]+\/(items|models\/item)\/[^/]+\.json$/;
/** Item tags, where the extractor reads them (data/<ns>/tags/item/). */
const ITEM_TAG = /^data\/[a-z0-9_.-]+\/tags\/item\/.+\.json$/;

export async function scanJar(buffer: ArrayBuffer): Promise<LocalJarScan> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const meta = await extractModMetadata(zip);
  return {
    hasClassFiles: names.some((n) => CLASS_FILE.test(n)),
    hasItemDefinitions: names.some((n) => ITEM_DEFINITION.test(n)),
    hasItemTags: names.some((n) => ITEM_TAG.test(n)),
    modId: meta.modId,
    displayName: meta.displayName,
    loaders: meta.loaders,
    size: buffer.byteLength,
  };
}

/**
 * Whether a file name in a mods folder is an active mod JAR: ends with
 * `.jar` (any case); not a dotfile and not a disabled/backup copy
 * (`x.jar.disabled`, `x.jar.old`, `x.jar.bak` don't end with `.jar`).
 */
export function isJarFilename(name: string): boolean {
  const base = basename(name);
  return base.length > 4 && !base.startsWith(".") && /\.jar$/i.test(base);
}
