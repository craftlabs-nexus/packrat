/**
 * Synthetic JAR / zip fixtures for pack import tests (no real mod JARs are
 * committed). Entries are written with a fixed date so the same content
 * zips to the same bytes (and the same sha512).
 */
import JSZip from "jszip";

const FIXED_DATE = new Date("2026-01-01T00:00:00Z");

export async function makeZipBytes(
  files: Record<string, string | Uint8Array>,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) {
    zip.file(path, contents, { date: FIXED_DATE });
  }
  return zip.generateAsync({ type: "uint8array" });
}

export async function makeZipFile(
  files: Record<string, string | Uint8Array>,
  name: string,
): Promise<File> {
  const bytes = await makeZipBytes(files);
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

/** A Fabric mod JAR with code and one item per id. */
export async function makeModJar(
  modId: string,
  itemIds: string[] = ["thing"],
  name = `${modId}.jar`,
  extra: Record<string, string> = {},
): Promise<File> {
  const files: Record<string, string> = {
    "fabric.mod.json": JSON.stringify({ id: modId, name: `${modId} mod`, version: "1.0.0" }),
    [`com/example/${modId}/Mod.class`]: "",
    ...extra,
  };
  for (const id of itemIds) files[`assets/${modId}/items/${id}.json`] = "{}";
  return makeZipFile(files, name);
}
