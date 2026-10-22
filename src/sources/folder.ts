/**
 * Folder input: a dropped or chosen launcher instance (Prism/MultiMC,
 * CurseForge app, ATLauncher, Modrinth app) or a plain mods folder.
 */
import { parse as parseToml } from "smol-toml";
import { isJarFilename } from "../jarScan";
import {
  atlauncherInstanceSchema,
  curseforgeInstanceSchema,
  mmcPackSchema,
  modrinthProfileSchema,
  pwTomlSchema,
  type PwToml,
} from "../schemas";
import {
  PackImportError,
  type PackAnalysis,
  type PackEntry,
  type PackLoaderId,
  type PackManifestInfo,
} from "../types";

/** A file with its path relative to the dropped/chosen root ("/"-separated). */
export interface LocalFile {
  relativePath: string;
  file: File;
}

/** Normalize a path: "/" separators, no leading "./" or "/". */
export function normalizePath(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./") || p.startsWith("/")) {
    p = p.startsWith("./") ? p.slice(2) : p.slice(1);
  }
  return p;
}

/** From <input type="file" webkitdirectory> (or plain multi-file input). */
export function fromFileList(files: FileList | File[]): LocalFile[] {
  return Array.from(files).map((file) => ({
    relativePath: normalizePath(file.webkitRelativePath || file.name),
    file,
  }));
}

/**
 * From react-dropzone (file-selector sets `relativePath` on every file, the
 * traversed entry path for dropped directories).
 */
export function fromDropzoneFiles(files: File[]): LocalFile[] {
  return files.map((file) => {
    const f = file as File & { relativePath?: string; path?: string };
    const raw = f.relativePath || f.path || f.webkitRelativePath || f.name;
    return { relativePath: normalizePath(raw), file };
  });
}

const INSTANCE_FILES = [
  "mmc-pack.json",
  "instance.cfg",
  "minecraftinstance.json",
  "instance.json",
  "profile.json",
] as const;

const MAX_MODS_FOLDER_DEPTH = 4;

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "" for the root, else the directory itself and each ancestor up to "". */
function selfAndAncestors(dir: string): string[] {
  const out = [dir];
  let d = dir;
  while (d !== "") {
    d = dirname(d);
    out.push(d);
  }
  return out;
}

function isPreferredModsFolder(dir: string): boolean {
  return /(^|\/)\.?minecraft\/mods$/.test(dir);
}

/** The dropped root's display name: the shared first segment, if any. */
function rootName(files: LocalFile[]): string {
  const first = files[0]?.relativePath.split("/")[0];
  if (
    first &&
    files.every((f) => f.relativePath.split("/")[0] === first) &&
    files.some((f) => f.relativePath.includes("/"))
  ) {
    return first;
  }
  return "the dropped files";
}

export interface ModsFolderResult {
  modsFolder: string;
  candidates: string[];
  /** Direct child JARs of the chosen folder */
  jars: LocalFile[];
  /** .index/*.pw.toml of the chosen folder plus instance files at its ancestors */
  metaFiles: LocalFile[];
}

/**
 * Find the mods folder: every directory named `mods` (depth <= 4) with at
 * least one direct child JAR, plus the root (or the single top folder) when
 * it holds JARs directly. Prefers `.minecraft/mods` / `minecraft/mods`
 * (Prism/MultiMC), else the folder with the most JARs; `preferred` overrides
 * when it is a candidate. Subfolders (`mods/disabled/`...) are ignored.
 */
export function findModsFolder(
  files: LocalFile[],
  preferred?: string,
): ModsFolderResult {
  const jarsByDir = new Map<string, LocalFile[]>();
  for (const f of files) {
    if (!isJarFilename(f.relativePath)) continue;
    const dir = dirname(f.relativePath);
    const list = jarsByDir.get(dir) ?? [];
    list.push(f);
    jarsByDir.set(dir, list);
  }

  const name = rootName(files);
  const topFolder = name === "the dropped files" ? "" : name;
  const candidates = [...jarsByDir.keys()].filter((dir) => {
    if (dir === "" || dir === topFolder) return true;
    const segments = dir.split("/");
    return (
      segments[segments.length - 1] === "mods" &&
      segments.length <= MAX_MODS_FOLDER_DEPTH
    );
  });

  if (candidates.length === 0) {
    throw new PackImportError(
      "NO_MODS_FOLDER",
      `No mods folder with .jar files was found in ${name}`,
    );
  }

  const count = (dir: string) => jarsByDir.get(dir)?.length ?? 0;
  candidates.sort((a, b) => {
    const pa = isPreferredModsFolder(a) ? 1 : 0;
    const pb = isPreferredModsFolder(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (count(a) !== count(b)) return count(b) - count(a);
    return a.localeCompare(b);
  });

  const modsFolder =
    preferred !== undefined && candidates.includes(preferred)
      ? preferred
      : candidates[0];

  const indexDir = modsFolder === "" ? ".index" : `${modsFolder}/.index`;
  const ancestors = new Set(selfAndAncestors(dirname(modsFolder)));
  ancestors.add(modsFolder);
  const metaFiles = files.filter((f) => {
    const dir = dirname(f.relativePath);
    const base = basename(f.relativePath);
    if (dir === indexDir && base.endsWith(".pw.toml")) return true;
    return (
      ancestors.has(dir) &&
      (INSTANCE_FILES as readonly string[]).includes(base)
    );
  });

  return {
    modsFolder,
    candidates,
    jars: jarsByDir.get(modsFolder) ?? [],
    metaFiles,
  };
}

/** Map a loader name/uid to our loader id ("fabric-0.16.9" -> fabric). */
export function loaderFromName(
  name: string | undefined,
): { id: PackLoaderId; version?: string } | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  const dash = lower.indexOf("-");
  const head = dash === -1 ? lower : lower.slice(0, dash);
  const version = dash === -1 ? undefined : name.slice(dash + 1) || undefined;
  if (head === "fabric" || head === "quilt" || head === "neoforge" || head === "forge") {
    return { id: head, version };
  }
  return undefined;
}

const MMC_LOADER_UIDS: Record<string, PackLoaderId> = {
  "net.fabricmc.fabric-loader": "fabric",
  "org.quiltmc.quilt-loader": "quilt",
  "net.neoforged": "neoforge",
  "net.minecraftforge": "forge",
};

/** A File's text (UTF-8); "" when it cannot be read. */
export async function readFileText(file: Blob): Promise<string> {
  try {
    return new TextDecoder().decode(await file.arrayBuffer());
  } catch {
    return "";
  }
}

async function readJson(file: LocalFile): Promise<unknown> {
  try {
    return JSON.parse(await readFileText(file.file));
  } catch {
    return undefined;
  }
}

/** Parse a .pw.toml; undefined when it is not valid TOML or not the format. */
export function parsePwToml(text: string): PwToml | undefined {
  try {
    const parsed = pwTomlSchema.safeParse(parseToml(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Fill entry fields from a .pw.toml (packwiz or Prism mods/.index). */
export function applyPwToml(entry: PackEntry, pw: PwToml): void {
  entry.side = pw.side;
  const format = pw.download["hash-format"]?.toLowerCase();
  const hash = pw.download.hash?.toLowerCase();
  if (hash && format === "sha512") entry.sha512 = hash;
  if (hash && format === "sha1") entry.sha1 = hash;
  const modrinth = pw.update?.modrinth;
  if (modrinth) {
    entry.modrinth = {
      projectId: modrinth["mod-id"],
      versionId: modrinth.version,
    };
  }
  const curseforge = pw.update?.curseforge;
  if (curseforge) {
    entry.curseforge = {
      projectId: curseforge["project-id"],
      fileId: curseforge["file-id"],
    };
  }
  if (pw.option?.optional && !pw.option.default) entry.optional = true;
}

async function readInstanceInfo(
  metaFiles: LocalFile[],
): Promise<Pick<PackManifestInfo, "name" | "minecraftVersion" | "loader">> {
  const info: Pick<PackManifestInfo, "name" | "minecraftVersion" | "loader"> =
    {};
  // Nearest files first (deepest directory), so an instance's own files win
  const ordered = [...metaFiles].sort(
    (a, b) => b.relativePath.split("/").length - a.relativePath.split("/").length,
  );
  for (const f of ordered) {
    const base = basename(f.relativePath);
    if (base === "mmc-pack.json") {
      const parsed = mmcPackSchema.safeParse(await readJson(f));
      if (!parsed.success) continue;
      for (const c of parsed.data.components) {
        if (c.uid === "net.minecraft" && c.version) {
          info.minecraftVersion ??= c.version;
        }
        const loader = MMC_LOADER_UIDS[c.uid];
        if (loader) info.loader ??= { id: loader, version: c.version };
      }
    } else if (base === "instance.cfg") {
      const text = await readFileText(f.file);
      const line = text.split(/\r?\n/).find((l) => l.startsWith("name="));
      const name = line?.slice("name=".length).trim();
      if (name) info.name ??= name;
    } else if (base === "minecraftinstance.json") {
      const parsed = curseforgeInstanceSchema.safeParse(await readJson(f));
      if (!parsed.success) continue;
      const d = parsed.data;
      const version = d.gameVersion || d.baseModLoader?.minecraftVersion;
      if (version) info.minecraftVersion ??= version;
      if (d.name) info.name ??= d.name;
      const loader = loaderFromName(d.baseModLoader?.name);
      if (loader) info.loader ??= loader;
    } else if (base === "instance.json") {
      const parsed = atlauncherInstanceSchema.safeParse(await readJson(f));
      if (!parsed.success) continue;
      if (parsed.data.minecraftVersion) {
        info.minecraftVersion ??= parsed.data.minecraftVersion;
      }
      const name = parsed.data.launcher?.name;
      if (name) info.name ??= name;
    } else if (base === "profile.json") {
      const parsed = modrinthProfileSchema.safeParse(await readJson(f));
      if (!parsed.success) continue;
      const d = parsed.data;
      const version = d.metadata?.game_version ?? d.game_version;
      if (version) info.minecraftVersion ??= version;
      const name = d.metadata?.name ?? d.name;
      if (name) info.name ??= name;
    }
  }
  return info;
}

/** A readable default name: the first folder of the path that isn't generic. */
function folderDisplayName(modsFolder: string): string | undefined {
  const generic = new Set(["mods", ".minecraft", "minecraft"]);
  return modsFolder.split("/").find((s) => s !== "" && !generic.has(s));
}

/**
 * Analyze a folder: entries for the chosen mods folder's JARs, with
 * Modrinth ids, side and hashes from a sibling `.index/*.pw.toml`, and the
 * pack name / Minecraft version / loader from instance files.
 */
export async function analyzeFolder(
  files: LocalFile[],
  preferredModsFolder?: string,
  fallbackName = "Mods folder",
): Promise<PackAnalysis> {
  const { modsFolder, candidates, jars, metaFiles } = findModsFolder(
    files,
    preferredModsFolder,
  );

  const entries: PackEntry[] = jars.map((jar) => ({
    key: jar.relativePath,
    filename: basename(jar.relativePath),
    origin: { type: "local", file: jar.file, relativePath: jar.relativePath },
  }));

  const byFilename = new Map(entries.map((e) => [e.filename, e]));
  for (const meta of metaFiles) {
    if (!meta.relativePath.endsWith(".pw.toml")) continue;
    const pw = parsePwToml(await readFileText(meta.file));
    const entry = pw && byFilename.get(pw.filename);
    if (pw && entry) applyPwToml(entry, pw);
  }

  const info = await readInstanceInfo(
    metaFiles.filter((f) => !f.relativePath.endsWith(".pw.toml")),
  );

  return {
    manifest: {
      kind: "folder",
      name: info.name ?? folderDisplayName(modsFolder) ?? fallbackName,
      minecraftVersion: info.minecraftVersion,
      loader: info.loader,
      modsFolder,
      modsFolderCandidates: candidates,
    },
    entries,
  };
}
