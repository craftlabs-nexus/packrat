/**
 * CurseForge modpack zip: manifest.json lists CurseForge project/file ids,
 * which the browser cannot download (the CurseForge API needs a key), so
 * only the JARs bundled under overrides/mods/ can be imported.
 */
import { describeZodError, curseforgeManifestSchema } from "../schemas";
import { PackImportError, type PackAnalysis, type PackEntry } from "../types";
import { loaderFromName } from "./folder";
import { loadPackZip, overrideJarEntries, readZipJson } from "./zip";

export const CURSEFORGE_UNRESOLVABLE =
  "CurseForge files cannot be downloaded in the browser (API key required); import from your CurseForge app instance folder instead";

export async function analyzeCurseforgeZip(file: File): Promise<PackAnalysis> {
  const zip = await loadPackZip(file, file.name);
  const raw = await readZipJson(zip, "manifest.json");
  if (raw === undefined) {
    throw new PackImportError(
      "INVALID_PACK",
      `${file.name} is not a CurseForge pack: manifest.json is missing`,
    );
  }
  const parsed = curseforgeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PackImportError(
      "INVALID_PACK",
      `Invalid CurseForge manifest.json: ${describeZodError(parsed.error)}`,
    );
  }
  const manifest = parsed.data;
  const overrides = manifest.overrides.replace(/^\/+|\/+$/g, "") || "overrides";

  const entries: PackEntry[] = await overrideJarEntries(zip, overrides, "both");
  for (const f of manifest.files) {
    entries.push({
      key: `curseforge:${f.projectID}:${f.fileID}`,
      filename: `CurseForge project ${f.projectID} file ${f.fileID}`,
      curseforge: { projectId: f.projectID, fileId: f.fileID },
      optional: f.required === false ? true : undefined,
      unresolvable: CURSEFORGE_UNRESOLVABLE,
    });
  }

  const notes: string[] = [];
  const listed = manifest.files.length;
  if (listed > 0) {
    notes.push(
      `${listed} mod${listed > 1 ? "s" : ""} listed in manifest.json cannot be downloaded in the browser (CurseForge requires an API key); only the JARs in ${overrides}/mods are imported. To import everything, choose your CurseForge app instance folder instead.`,
    );
  }

  const loaders = manifest.minecraft.modLoaders ?? [];
  const primary = loaders.find((l) => l.primary) ?? loaders[0];

  return {
    manifest: {
      kind: "curseforge",
      name: manifest.name,
      minecraftVersion: manifest.minecraft.version,
      loader: loaderFromName(primary?.id),
    },
    entries,
    notes,
  };
}
