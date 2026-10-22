/**
 * Types for importing a modpack or mods folder: a source analyzer turns the
 * input into a manifest and entries, buildPlan() turns those into
 * reviewable rows, fetchRows() and runImport() fetch and import the
 * selected rows.
 */
import type { UrlVerdict } from "./downloadUrl";
import type { modrinthSideSchema } from "./schemas";
import type { z } from "zod";

/** The mod loaders a JAR's metadata can name. */
export type ModLoader = "fabric" | "quilt" | "forge" | "neoforge";

export type PackKind = "folder" | "mrpack" | "curseforge" | "packwiz";
export type PackSide = "client" | "server" | "both";
export type PackLoaderId = "fabric" | "forge" | "neoforge" | "quilt";

export interface PackManifestInfo {
  kind: PackKind;
  name?: string;
  /** Minecraft version the pack targets, e.g. "26.2" */
  minecraftVersion?: string;
  loader?: { id: PackLoaderId; version?: string };
  /** folder kind: the mods folder actually used (relative to the dropped root) */
  modsFolder?: string;
  /** folder kind: every mods folder found (the UI offers a choice when > 1) */
  modsFolderCandidates?: string[];
  /** packwiz kind: the origin the pack was fetched from (its files are reachable) */
  packOrigin?: string;
}

export type PackFileOrigin =
  | { type: "local"; file: File; relativePath: string }
  | {
      type: "remote";
      url: string;
      /** Other URLs for the same bytes, tried in order when `url` fails */
      altUrls?: string[];
      size?: number;
    };

export interface PackEntry {
  /** Unique per plan: relative path or URL */
  key: string;
  filename: string;
  /** undefined when the pack only lists the file (see unresolvable) */
  origin?: PackFileOrigin;
  /** From pack metadata */
  side?: PackSide;
  /** Lowercase hex, from the manifest or computed */
  sha512?: string;
  sha1?: string;
  /** packwiz files hashed with its default hash-format */
  sha256?: string;
  modrinth?: { projectId?: string; versionId?: string };
  curseforge?: { projectId: number; fileId: number };
  /** packwiz [option] optional = true, default = false */
  optional?: boolean;
  /** Why it cannot be fetched in the browser */
  unresolvable?: string;
}

/** What a manifest analyzer returns. */
export interface PackAnalysis {
  manifest: PackManifestInfo;
  entries: PackEntry[];
  notes?: string[];
}

/**
 * From the zip central directory (no decompression of content). The item
 * fields serve the default content rule (`itemContentRule`).
 */
export interface LocalJarScan {
  hasClassFiles: boolean;
  /** assets/<ns != minecraft>/items/*.json or models/item/*.json */
  hasItemDefinitions: boolean;
  /** data/<ns>/tags/item/**.json: item tags (possibly for other mods' items) */
  hasItemTags: boolean;
  modId?: string;
  displayName?: string;
  loaders: ModLoader[];
  size: number;
}

export type SkipReason =
  | "client-only"
  | "no-items"
  | "already-imported"
  | "duplicate-in-pack"
  | "optional";

export type ReviewStatus =
  /** tagsOnly: a mod with code and item tags but no items of its own */
  | { kind: "import"; tagsOnly?: boolean }
  | { kind: "skip"; reason: SkipReason; detail?: string }
  | { kind: "unresolvable"; reason: string };

/** Modrinth's client_side/server_side (newer API versions also say "unknown") */
export type ModrinthSide = z.infer<typeof modrinthSideSchema>;

export interface ModrinthProjectInfo {
  id: string;
  title: string;
  iconUrl: string | null;
  clientSide: ModrinthSide;
  serverSide: ModrinthSide;
}

export interface ReviewRow {
  entry: PackEntry;
  status: ReviewStatus;
  /** import, client-only and optional rows can be ticked; others cannot */
  selectable: boolean;
  /** default: status.kind === "import" */
  selected: boolean;
  /** Modrinth project title, else the JAR's mod name, else the filename */
  title: string;
  iconUrl?: string;
  modrinthProject?: ModrinthProjectInfo;
  modrinthProjectId?: string;
  modrinthVersionId?: string;
  scan?: LocalJarScan;
  /** Remote rows: can the page download it (see downloadUrl.ts) */
  download?: UrlVerdict;
}

export type VersionAction =
  | { kind: "none" }
  | { kind: "switch"; to: string }
  | { kind: "note"; text: string };

export interface ImportPlan {
  manifest: PackManifestInfo;
  rows: ReviewRow[];
  /**
   * Proposal for the consumer's bundled vanilla version; "none" unless the
   * context gave availableVersions
   */
  versionAction: VersionAction;
  /** Shown above the list (e.g. CurseForge limitation, Modrinth lookup failure) */
  notes: string[];
}

export type PackImportErrorCode =
  | "NO_MODS_FOLDER"
  | "INVALID_PACK"
  | "FETCH_FAILED"
  | "UNSUPPORTED_INPUT";

export class PackImportError extends Error {
  readonly code: PackImportErrorCode;

  constructor(code: PackImportErrorCode, message: string) {
    super(message);
    this.name = "PackImportError";
    this.code = code;
  }
}

/**
 * What the plan needs to know about a JAR the consumer already holds, to
 * mark a pack entry "already imported": matched by sha512 (any case), then
 * Modrinth project, then mod id, then filename.
 */
export interface ExistingSource {
  filename: string;
  /** Match a pack JAR with the same mod id. Default true. */
  matchByModId?: boolean;
  /** Match a pack JAR with the same filename. Default true. */
  matchByFilename?: boolean;
  modId?: string;
  sha512?: string;
  modrinthProjectId?: string;
  /** Names for the "already imported" detail; the first non-empty wins, else the filename */
  displayName?: string;
  modDisplayName?: string;
}

/** What the runner tells the consumer's `commit` about a JAR it imported. */
export interface ImportMetadata {
  packName?: string;
  /**
   * Lowercase hex SHA-512 of the JAR bytes: the pack's when verify confirmed
   * it, else computed (absent when hashing is unavailable). Never an
   * unverified claim of the pack.
   */
  sha512?: string;
  /** The bytes matched every hash the pack lists for the file */
  hashVerified: boolean;
  modrinthProjectId?: string;
  modrinthVersionId?: string;
  iconUrl?: string;
  displayName?: string;
}

