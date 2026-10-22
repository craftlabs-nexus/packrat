/**
 * Unified mod metadata extraction from JAR files.
 * Parses Fabric, Quilt, Forge, and NeoForge metadata files once
 * and extracts all relevant fields.
 */

import JSZip from "jszip";
import { parse as parseToml } from "smol-toml";
import type { ModLoader } from "./types";

/**
 * Paths to mod loader metadata files in JARs.
 */
const METADATA_PATHS = {
  fabric: "fabric.mod.json",
  quilt: "quilt.mod.json",
  forge: "META-INF/mods.toml",
  neoforge: "META-INF/neoforge.mods.toml",
  // Legacy Forge format (pre-1.13)
  mcmodInfo: "mcmod.info",
} as const;

/** A loader's parsed metadata file (untrusted: every field is checked when read). */
interface ParsedMetadata {
  loader: ModLoader;
  data: Record<string, unknown>;
}

/**
 * All metadata fields we can extract from a mod JAR.
 */
export interface ModMetadata {
  /** Detected mod loaders (fabric, quilt, forge, neoforge) */
  loaders: ModLoader[];
  /** Primary mod ID (for duplicate detection) */
  modId?: string;
  /** Human-readable display name */
  displayName?: string;
  /** Mod version */
  version?: string;
  /** Path to icon file within the JAR */
  iconPath?: string;
  /**
   * Minecraft version requirement string. A list of alternatives (Fabric's
   * and Quilt's "any of" arrays) is joined with ", ".
   */
  minecraftVersions?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** A version requirement: a string, or an array of alternatives joined with ", ". */
function versionRequirement(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return undefined;
  const alternatives = v.filter((x): x is string => typeof x === "string");
  return alternatives.length > 0 ? alternatives.join(", ") : undefined;
}

/**
 * Load and parse a metadata file from a JAR.
 * Returns undefined if file doesn't exist, fails to parse or is not an object.
 */
async function loadMetadataFile(
  zip: JSZip,
  path: string,
  format: "json" | "toml"
): Promise<Record<string, unknown> | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;

  try {
    const content = await file.async("string");
    return obj(format === "json" ? JSON.parse(content) : parseToml(content));
  } catch {
    return undefined;
  }
}

/**
 * Load all available metadata files from the JAR.
 * Returns array of parsed metadata with their loader type.
 */
async function loadAllMetadata(zip: JSZip): Promise<ParsedMetadata[]> {
  // Load all metadata files in parallel
  const [fabric, quilt, forge, neoforge] = await Promise.all([
    loadMetadataFile(zip, METADATA_PATHS.fabric, "json"),
    loadMetadataFile(zip, METADATA_PATHS.quilt, "json"),
    loadMetadataFile(zip, METADATA_PATHS.forge, "toml"),
    loadMetadataFile(zip, METADATA_PATHS.neoforge, "toml"),
  ]);

  const results: ParsedMetadata[] = [];
  if (fabric) results.push({ loader: "fabric", data: fabric });
  if (quilt) results.push({ loader: "quilt", data: quilt });
  if (forge) results.push({ loader: "forge", data: forge });
  if (neoforge) results.push({ loader: "neoforge", data: neoforge });
  return results;
}

/** The fields of one metadata file (Forge and NeoForge share mods.toml's shape). */
function fieldsOf(meta: ParsedMetadata): Omit<ModMetadata, "loaders"> {
  const { data } = meta;
  switch (meta.loader) {
    case "fabric":
      return {
        modId: str(data.id),
        displayName: str(data.name),
        version: str(data.version),
        // an icon map (size -> path) is not read
        iconPath: str(data.icon),
        minecraftVersions: versionRequirement(obj(data.depends)?.minecraft),
      };
    case "quilt": {
      const loader = obj(data.quilt_loader);
      const metadata = obj(loader?.metadata);
      const depends = Array.isArray(loader?.depends) ? loader.depends : [];
      const minecraft = depends.map(obj).find((d) => d?.id === "minecraft");
      return {
        modId: str(loader?.id),
        displayName: str(metadata?.name),
        version: str(loader?.version),
        iconPath: str(metadata?.icon),
        minecraftVersions: versionRequirement(minecraft?.versions),
      };
    }
    case "forge":
    case "neoforge": {
      const first = Array.isArray(data.mods) ? obj(data.mods[0]) : undefined;
      // The minecraft dependency in any mod's dependencies
      let minecraftVersions: string | undefined;
      for (const modDeps of Object.values(obj(data.dependencies) ?? {})) {
        if (!Array.isArray(modDeps)) continue;
        const mc = modDeps.map(obj).find((d) => d?.modId === "minecraft");
        minecraftVersions = str(mc?.versionRange);
        if (minecraftVersions) break;
      }
      return {
        modId: str(first?.modId),
        displayName: str(first?.displayName),
        version: str(first?.version),
        iconPath: str(data.logoFile),
        minecraftVersions,
      };
    }
  }
}

/**
 * Extract all mod metadata from a JAR file.
 * Parses each metadata file once and extracts all relevant fields.
 */
export async function extractModMetadata(zip: JSZip): Promise<ModMetadata> {
  // Check for legacy mcmod.info (indicates Forge without mods.toml)
  const hasMcModInfo = zip.file(METADATA_PATHS.mcmodInfo) !== null;

  // Load and parse all metadata files once
  const allMeta = await loadAllMetadata(zip);

  // Determine loaders from which files exist
  const loaders: ModLoader[] = allMeta.map((m) => m.loader);
  if (hasMcModInfo && !loaders.includes("forge")) {
    loaders.push("forge");
  }

  // Extract fields from first available source (priority: fabric > quilt > neoforge > forge)
  const priorityOrder: ModLoader[] = ["fabric", "quilt", "neoforge", "forge"];
  const sortedMeta = [...allMeta].sort(
    (a, b) => priorityOrder.indexOf(a.loader) - priorityOrder.indexOf(b.loader)
  );

  // Extract each field from the first source that has it
  const result: ModMetadata = { loaders };
  for (const meta of sortedMeta) {
    const fields = fieldsOf(meta);
    result.modId ??= fields.modId;
    result.displayName ??= fields.displayName;
    result.version ??= fields.version;
    result.iconPath ??= fields.iconPath;
    result.minecraftVersions ??= fields.minecraftVersions;
  }
  return result;
}

/**
 * Check if a JAR contains any mod loader metadata files.
 */
export function isModJar(zip: JSZip): boolean {
  return Object.values(METADATA_PATHS).some((path) => zip.file(path) !== null);
}

const ICON_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

/**
 * Load icon from JAR and convert to base64 data URL (PNG unless the
 * extension says JPEG or GIF).
 */
export async function loadIconFromJar(
  zip: JSZip,
  iconPath: string
): Promise<string | undefined> {
  const iconFile = zip.file(iconPath);
  if (!iconFile) return undefined;

  try {
    const iconData = await iconFile.async("base64");
    const ext = iconPath.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = ICON_MIME_TYPES[ext] ?? "image/png";
    return `data:${mimeType};base64,${iconData}`;
  } catch {
    return undefined;
  }
}
