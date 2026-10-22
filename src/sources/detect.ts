/**
 * Recognize a single dropped/chosen zip: Modrinth .mrpack, CurseForge pack
 * zip, or a zipped mods folder / instance.
 */
import type JSZip from "jszip";
import { analyzeCurseforgeLoadedZip } from "./curseforge";
import { analyzeFolder, findModsFolder, type LocalFile } from "./folder";
import { analyzeMrpack, analyzeMrpackZip } from "./mrpack";
import { loadPackZip } from "./zip";
import { basename } from "../utils";
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
  return analyzeLoadedModsZip(await loadPackZip(file, file.name), file.name, preferredModsFolder);
}

async function analyzeLoadedModsZip(
  zip: JSZip,
  label: string,
  preferredModsFolder?: string,
): Promise<PackAnalysis> {
  // Every candidate is kept, though only the chosen folder's files are extracted
  const { jars, metaFiles, candidates } = findModsFolder(
    nameOnly(zipFileNames(zip)),
    preferredModsFolder,
  );
  const wanted = [...jars, ...metaFiles].map((f) => f.relativePath);
  const files: LocalFile[] = [];
  for (const path of wanted) {
    const bytes = await zip.files[path].async("uint8array");
    files.push({
      relativePath: path,
      file: new File([bytes as Uint8Array<ArrayBuffer>], basename(path)),
    });
  }
  const analysis = await analyzeFolder(files, {
    fallbackName: label.replace(/\.zip$/i, ""),
  });
  analysis.manifest.modsFolderCandidates = candidates;
  return analysis;
}

/** Analyze a single pack zip of any supported kind. */
export async function analyzePackZip(
  file: File,
  preferredModsFolder?: string,
): Promise<PackAnalysis> {
  if (/\.mrpack$/i.test(file.name)) return analyzeMrpack(file);
  // The zip is read once, for detection and analysis
  const zip = await loadPackZip(file, file.name).catch(() => undefined);
  const kind = zip ? detectFromZip(zip) : null;
  if (zip && kind === "mrpack") return analyzeMrpackZip(zip, file.name);
  if (zip && kind === "curseforge") return analyzeCurseforgeLoadedZip(zip, file.name);
  if (zip && kind === "mods-zip") return analyzeLoadedModsZip(zip, file.name, preferredModsFolder);
  throw new PackImportError(
    "UNSUPPORTED_INPUT",
    `${file.name} is not a Modrinth pack (.mrpack), a CurseForge pack zip or a zipped mods folder`,
  );
}
