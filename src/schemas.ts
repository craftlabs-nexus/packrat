/**
 * Zod schemas for every untrusted pack input: Modrinth .mrpack index,
 * CurseForge manifest, packwiz pack/index/.pw.toml (also Prism's
 * mods/.index), launcher instance files and Modrinth API responses.
 * Objects are loose (unknown keys are kept), so format additions don't break
 * parsing.
 */
import { z } from "zod";

/**
 * A relative path inside a pack: no `..` segments, no leading `/` or drive
 * letter, no backslash, no NUL. Guards against path traversal in pack files.
 */
export const safeRelativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes("\0") &&
      !p.includes("\\") &&
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      !p.split("/").includes(".."),
    { message: "unsafe relative path" },
  );

// ---------------------------------------------------------------------------
// Modrinth .mrpack (modrinth.index.json)
// ---------------------------------------------------------------------------

const mrpackSide = z.enum(["required", "optional", "unsupported"]);

export const mrpackFileSchema = z.looseObject({
  path: safeRelativePath,
  hashes: z.looseObject({
    sha1: z.string().optional(),
    sha512: z.string().optional(),
  }),
  env: z.looseObject({ client: mrpackSide, server: mrpackSide }).optional(),
  downloads: z.array(z.url()),
  fileSize: z.number().optional(),
});

export const mrpackIndexSchema = z.looseObject({
  formatVersion: z.number(),
  game: z.literal("minecraft"),
  versionId: z.string(),
  name: z.string(),
  files: z.array(mrpackFileSchema),
  dependencies: z.record(z.string(), z.string()),
});

export type MrpackIndex = z.infer<typeof mrpackIndexSchema>;

// ---------------------------------------------------------------------------
// CurseForge modpack zip (manifest.json)
// ---------------------------------------------------------------------------

export const curseforgeManifestSchema = z.looseObject({
  manifestType: z.literal("minecraftModpack"),
  minecraft: z.looseObject({
    version: z.string(),
    modLoaders: z
      .array(z.looseObject({ id: z.string(), primary: z.boolean().optional() }))
      .optional(),
  }),
  name: z.string().optional(),
  files: z.array(
    z.looseObject({
      projectID: z.number(),
      fileID: z.number(),
      required: z.boolean().optional(),
    }),
  ),
  overrides: z.string().default("overrides"),
});

export type CurseforgeManifest = z.infer<typeof curseforgeManifestSchema>;

// ---------------------------------------------------------------------------
// packwiz (pack.toml, index.toml, *.pw.toml; Prism writes the same
// .pw.toml format to mods/.index/)
// ---------------------------------------------------------------------------

export const packTomlSchema = z.looseObject({
  name: z.string().optional(),
  index: z.looseObject({
    file: z.string(),
    "hash-format": z.string().optional(),
    hash: z.string().optional(),
  }),
  versions: z.record(z.string(), z.string()).optional(),
});

export const indexTomlSchema = z.looseObject({
  "hash-format": z.string().optional(),
  files: z
    .array(
      z.looseObject({
        file: z.string(),
        hash: z.string().optional(),
        /** Overrides the index's hash-format for this file */
        "hash-format": z.string().optional(),
        metafile: z.boolean().optional(),
        alias: z.string().optional(),
      }),
    )
    .default([]),
});

export const pwTomlSchema = z.looseObject({
  name: z.string().optional(),
  filename: z.string(),
  side: z.enum(["client", "server", "both"]).default("both"),
  download: z.looseObject({
    url: z.url().optional(),
    "hash-format": z.string().optional(),
    hash: z.string().optional(),
    mode: z.string().optional(),
  }),
  update: z
    .looseObject({
      modrinth: z
        .looseObject({ "mod-id": z.string(), version: z.string() })
        .optional(),
      curseforge: z
        .looseObject({ "project-id": z.number(), "file-id": z.number() })
        .optional(),
    })
    .optional(),
  option: z
    .looseObject({
      optional: z.boolean().optional(),
      default: z.boolean().optional(),
    })
    .optional(),
});

export type PwToml = z.infer<typeof pwTomlSchema>;

// ---------------------------------------------------------------------------
// Launcher instance files
// ---------------------------------------------------------------------------

/** Prism Launcher / MultiMC mmc-pack.json */
export const mmcPackSchema = z.looseObject({
  components: z.array(
    z.looseObject({ uid: z.string(), version: z.string().optional() }),
  ),
});

/** CurseForge app minecraftinstance.json */
export const curseforgeInstanceSchema = z.looseObject({
  name: z.string().optional(),
  gameVersion: z.string().optional(),
  baseModLoader: z
    .looseObject({
      minecraftVersion: z.string().optional(),
      name: z.string().optional(),
    })
    .nullable()
    .optional(),
});

/** ATLauncher instance.json (best effort) */
export const atlauncherInstanceSchema = z.looseObject({
  id: z.string().optional(),
  minecraftVersion: z.string().optional(),
  launcher: z.looseObject({ name: z.string().optional() }).optional(),
});

/** Older Modrinth app profile.json (best effort) */
export const modrinthProfileSchema = z.looseObject({
  metadata: z
    .looseObject({
      name: z.string().optional(),
      game_version: z.string().optional(),
    })
    .optional(),
  name: z.string().optional(),
  game_version: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Modrinth API responses (only the fields pack import uses)
// ---------------------------------------------------------------------------

/** Modrinth's client_side/server_side (newer API versions also say "unknown"). */
export const modrinthSideSchema = z.enum(["required", "optional", "unsupported", "unknown"]);

/** A version's file, as POST /version_files returns it (the fields the resolver reads). */
export const modrinthFileSchema = z.looseObject({
  hashes: z.looseObject({
    sha1: z.string().optional(),
    sha512: z.string().optional(),
  }),
  url: z.string(),
  filename: z.string(),
  primary: z.boolean().optional(),
});

/** A version as POST /version_files returns it (the fields the resolver reads). */
export const modrinthVersionSchema = z.looseObject({
  id: z.string(),
  project_id: z.string(),
  files: z.array(modrinthFileSchema),
});

/** A project as GET /projects returns it (the fields the resolver reads). */
export const modrinthProjectSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  icon_url: z.string().nullable().optional(),
  client_side: modrinthSideSchema,
  server_side: modrinthSideSchema,
});

/** POST /version_files: versions keyed by the queried hash (each parsed on its own). */
export const modrinthVersionFilesResponseSchema = z.record(z.string(), z.unknown());

/** GET /projects: a list of projects (each parsed on its own). */
export const modrinthProjectsResponseSchema = z.array(z.unknown());

export type ModrinthFile = z.infer<typeof modrinthFileSchema>;
export type ModrinthVersion = z.infer<typeof modrinthVersionSchema>;
export type ModrinthProjectDetails = z.infer<typeof modrinthProjectSchema>;

/** Short, readable summary of a zod error for user-facing messages. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid data";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  const more = error.issues.length > 1 ? ` (+${error.issues.length - 1} more)` : "";
  return `${path}${issue.message}${more}`;
}
