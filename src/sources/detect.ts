/**
 * Recognize a single dropped/chosen zip: Modrinth .mrpack, CurseForge pack
 * zip, or a zipped mods folder / instance.
 */
import type JSZip from "jszip";
import { analyzeCurseforgeZip } from "./curseforge";
import { analyzeFolder, findModsFolder, type LocalFile } from "./folder";
import { analyzeMrpack } from "./mrpack";
import { loadPackZip } from "./zip";
import { PackImportError, type PackAnalysis } from "../types";

export type PackZipKind = "mrpack" | "curseforge" | "mods-zip";

function zipFileNames(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((p) => !zip.files[p].dir);
}

/** Placeholder LocalFiles (names only) for running findModsFolder on a zip. */
function nameOnly(paths: string[]): LocalFile[] {
  return paths.map((relativePath) => ({ relativePath, file: new File([], "") }));
}

function detectFromZip(zip: JSZip): PackZipKind | null {
  if (zip.file("modrinth.index.json")) return "mrpack";
  if (zip.file("manifest.json")) return "curseforge";
  try {
    findModsFolder(nameOnly(zipFileNames(zip)));
    return "mods-zip";
  } catch {
    return null;
  }
}

/** What kind of pack a zip is, or null when it is none of them. */
export async function detectPackZip(file: File): Promise<PackZipKind | null> {
  if (/\.mrpack$/i.test(file.name)) return "mrpack";
  try {
    return detectFromZip(await loadPackZip(file, file.name));
  } catch {
    return null;
  }
}

/**
 * A zipped mods folder or instance: find the mods folder by name, then
 * extract only its JARs and metadata files and analyze them as a folder.
 */
export async function analyzeModsZip(
  file: File,
  preferredModsFolder?: string,
): Promise<PackAnalysis> {
  const zip = await loadPackZip(file, file.name);
  const names = zipFileNames(zip);
  const { jars, metaFiles } = findModsFolder(nameOnly(names), preferredModsFolder);
  const wanted = [...jars, ...metaFiles].map((f) => f.relativePath);
  const files: LocalFile[] = [];
  for (const path of wanted) {
    const bytes = await zip.files[path].async("uint8array");
    const name = path.slice(path.lastIndexOf("/") + 1);
    files.push({
      relativePath: path,
      file: new File([bytes as Uint8Array<ArrayBuffer>], name),
    });
  }
  // Keep every candidate (only the chosen folder's files were extracted)
  const { candidates } = findModsFolder(nameOnly(names));
  const analysis = await analyzeFolder(
    files,
    undefined,
    file.name.replace(/\.zip$/i, ""),
  );
  analysis.manifest.modsFolderCandidates = candidates;
  return analysis;
}

/** Analyze a single pack zip of any supported kind. */
export async function analyzePackZip(
  file: File,
  preferredModsFolder?: string,
): Promise<PackAnalysis> {
  const kind = await detectPackZip(file);
  if (kind === "mrpack") return analyzeMrpack(file);
  if (kind === "curseforge") return analyzeCurseforgeZip(file);
  if (kind === "mods-zip") return analyzeModsZip(file, preferredModsFolder);
  throw new PackImportError(
    "UNSUPPORTED_INPUT",
    `${file.name} is not a Modrinth pack (.mrpack), a CurseForge pack zip or a zipped mods folder`,
  );
}
