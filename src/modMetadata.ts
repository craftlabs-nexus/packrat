/**
 * Unified mod metadata extraction from JAR files.
 * Parses Fabric, Quilt, Forge, and NeoForge metadata files once
 * and extracts all relevant fields.
 */

import JSZip from "jszip";
import { parse as parseToml } from "smol-toml";
import { match, P } from "ts-pattern";
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

/**
 * Parsed content from a mod loader metadata file.
 * Each loader has its own structure, represented as a discriminated union.
 */
type ParsedMetadata =
  | { loader: "fabric"; data: FabricModJson }
  | { loader: "quilt"; data: QuiltModJson }
  | { loader: "forge"; data: ForgeModsToml }
  | { loader: "neoforge"; data: NeoForgeModsToml };

/** Fabric mod.json schema (simplified) */
interface FabricModJson {
  id?: string;
  name?: string;
  version?: string;
  icon?: string;
  depends?: { minecraft?: string };
}

/** Quilt mod.json schema (simplified) */
interface QuiltModJson {
  quilt_loader?: {
    id?: string;
    version?: string;
    metadata?: {
      name?: string;
      icon?: string;
    };
    depends?: Array<{ id?: string; versions?: string }>;
  };
}

/** Forge/NeoForge mods.toml schema (simplified) */
interface ForgeModsToml {
  logoFile?: string;
  mods?: Array<{
    modId?: string;
    displayName?: string;
    version?: string;
  }>;
  dependencies?: Record<
    string,
    Array<{ modId?: string; versionRange?: string }>
  >;
}

// NeoForge uses same structure as Forge
type NeoForgeModsToml = ForgeModsToml;

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
  /** Minecraft version requirement string */
  minecraftVersions?: string;
}

/**
 * Load and parse a metadata file from a JAR.
 * Returns undefined if file doesn't exist or fails to parse.
 */
async function loadMetadataFile(
  zip: JSZip,
  path: string,
  format: "json" | "toml"
): Promise<unknown | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;

  try {
    const content = await file.async("string");
    return format === "json" ? JSON.parse(content) : parseToml(content);
  } catch {
    return undefined;
  }
}

/**
 * Load all available metadata files from the JAR.
 * Returns array of parsed metadata with their loader type.
 */
async function loadAllMetadata(zip: JSZip): Promise<ParsedMetadata[]> {
  const results: ParsedMetadata[] = [];

  // Load all metadata files in parallel
  const [fabric, quilt, forge, neoforge] = await Promise.all([
    loadMetadataFile(zip, METADATA_PATHS.fabric, "json"),
    loadMetadataFile(zip, METADATA_PATHS.quilt, "json"),
    loadMetadataFile(zip, METADATA_PATHS.forge, "toml"),
    loadMetadataFile(zip, METADATA_PATHS.neoforge, "toml"),
  ]);

  if (fabric) results.push({ loader: "fabric", data: fabric as FabricModJson });
  if (quilt) results.push({ loader: "quilt", data: quilt as QuiltModJson });
  if (forge) results.push({ loader: "forge", data: forge as ForgeModsToml });
  if (neoforge)
    results.push({ loader: "neoforge", data: neoforge as NeoForgeModsToml });

  return results;
}

/**
 * Extract mod ID from parsed metadata using ts-pattern.
 */
function extractModId(meta: ParsedMetadata): string | undefined {
  return match(meta)
    .with({ loader: "fabric", data: { id: P.string } }, ({ data }) => data.id)
    .with(
      { loader: "quilt", data: { quilt_loader: { id: P.string } } },
      ({ data }) => data.quilt_loader?.id
    )
    .with(
      { loader: P.union("forge", "neoforge"), data: { mods: P.array() } },
      ({ data }) => {
        const first = data.mods?.[0];
        return typeof first?.modId === "string" ? first.modId : undefined;
      }
    )
    .otherwise(() => undefined);
}

/**
 * Extract display name from parsed metadata using ts-pattern.
 */
function extractDisplayName(meta: ParsedMetadata): string | undefined {
  return match(meta)
    .with({ loader: "fabric", data: { name: P.string } }, ({ data }) => data.name)
    .with(
      { loader: "quilt", data: { quilt_loader: { metadata: { name: P.string } } } },
      ({ data }) => data.quilt_loader?.metadata?.name
    )
    .with(
      { loader: P.union("forge", "neoforge"), data: { mods: P.array() } },
      ({ data }) => {
        const first = data.mods?.[0];
        return typeof first?.displayName === "string"
          ? first.displayName
          : undefined;
      }
    )
    .otherwise(() => undefined);
}

/**
 * Extract version from parsed metadata using ts-pattern.
 */
function extractVersion(meta: ParsedMetadata): string | undefined {
  return match(meta)
    .with(
      { loader: "fabric", data: { version: P.string } },
      ({ data }) => data.version
    )
    .with(
      { loader: "quilt", data: { quilt_loader: { version: P.string } } },
      ({ data }) => data.quilt_loader?.version
    )
    .with(
      { loader: P.union("forge", "neoforge"), data: { mods: P.array() } },
      ({ data }) => {
        const first = data.mods?.[0];
        return typeof first?.version === "string" ? first.version : undefined;
      }
    )
    .otherwise(() => undefined);
}

/**
 * Extract icon path from parsed metadata using ts-pattern.
 */
function extractIconPath(meta: ParsedMetadata): string | undefined {
  return match(meta)
    .with({ loader: "fabric", data: { icon: P.string } }, ({ data }) => data.icon)
    .with(
      { loader: "quilt", data: { quilt_loader: { metadata: { icon: P.string } } } },
      ({ data }) => data.quilt_loader?.metadata?.icon
    )
    .with(
      { loader: P.union("forge", "neoforge"), data: { logoFile: P.string } },
      ({ data }) => data.logoFile
    )
    .otherwise(() => undefined);
}

/**
 * Extract Minecraft version requirement from parsed metadata using ts-pattern.
 */
function extractMinecraftVersions(meta: ParsedMetadata): string | undefined {
  return match(meta)
    .with(
      { loader: "fabric", data: { depends: { minecraft: P.select() } } },
      (mc) => (typeof mc === "string" ? mc : String(mc))
    )
    .with({ loader: "quilt", data: { quilt_loader: { depends: P.array() } } }, ({ data }) => {
      const mcDep = data.quilt_loader?.depends?.find((d) => d.id === "minecraft");
      return mcDep?.versions ? String(mcDep.versions) : undefined;
    })
    .with(
      { loader: P.union("forge", "neoforge"), data: { dependencies: P.select() } },
      (deps) => {
        if (!deps || typeof deps !== "object") return undefined;
        // Find minecraft dependency in any mod's dependencies
        for (const modDeps of Object.values(deps)) {
          if (!Array.isArray(modDeps)) continue;
          const mcDep = modDeps.find((d) => d.modId === "minecraft");
          if (mcDep?.versionRange) return String(mcDep.versionRange);
        }
        return undefined;
      }
    )
    .otherwise(() => undefined);
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
  let modId: string | undefined;
  let displayName: string | undefined;
  let version: string | undefined;
  let iconPath: string | undefined;
  let minecraftVersions: string | undefined;

  for (const meta of sortedMeta) {
    modId ??= extractModId(meta);
    displayName ??= extractDisplayName(meta);
    version ??= extractVersion(meta);
    iconPath ??= extractIconPath(meta);
    minecraftVersions ??= extractMinecraftVersions(meta);
  }

  return {
    loaders,
    modId,
    displayName,
    version,
    iconPath,
    minecraftVersions,
  };
}

/**
 * Check if a JAR contains any mod loader metadata files.
 */
export function isModJar(zip: JSZip): boolean {
  return (
    zip.file(METADATA_PATHS.fabric) !== null ||
    zip.file(METADATA_PATHS.quilt) !== null ||
    zip.file(METADATA_PATHS.forge) !== null ||
    zip.file(METADATA_PATHS.neoforge) !== null ||
    zip.file(METADATA_PATHS.mcmodInfo) !== null
  );
}

/**
 * Load icon from JAR and convert to base64 data URL.
 */
export async function loadIconFromJar(
  zip: JSZip,
  iconPath: string
): Promise<string | undefined> {
  const iconFile = zip.file(iconPath);
  if (!iconFile) return undefined;

  try {
    const iconData = await iconFile.async("base64");
    const ext = iconPath.split(".").pop()?.toLowerCase();
    const mimeType = match(ext)
      .with("png", () => "image/png")
      .with("jpg", () => "image/jpeg")
      .with("jpeg", () => "image/jpeg")
      .with("gif", () => "image/gif")
      .otherwise(() => "image/png");
    return `data:${mimeType};base64,${iconData}`;
  } catch {
    return undefined;
  }
}

