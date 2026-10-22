/**
 * Modpack / mods folder import (see ARCHITECTURE.md "Modpack import").
 */
export * from "./types";
export { scanJar, isJarFilename } from "./jarScan";
export {
  analyzeFolder,
  findModsFolder,
  fromDropzoneFiles,
  fromFileList,
  type LocalFile,
} from "./sources/folder";
export { analyzeMrpack } from "./sources/mrpack";
export { analyzeCurseforgeZip } from "./sources/curseforge";
export {
  analyzeModsZip,
  analyzePackZip,
  detectPackZip,
  type PackZipKind,
} from "./sources/detect";
export { analyzePackwiz, validatePackUrl } from "./sources/packwiz";
export {
  classifyDownloadUrl,
  currentPageProtocol,
  KNOWN_BLOCKED_HOSTS,
  KNOWN_GOOD_HOSTS,
  type ClassifyContext,
  type UrlVerdict,
} from "./downloadUrl";
export { createLimiter, type Limiter } from "./limiter";
export { resolveModrinth, type ResolveResult } from "./modrinthResolve";
export {
  buildPlan,
  proposeVersionAction,
  sourceDisplayName,
  type BuildPlanContext,
  type BundledVersionRef,
} from "./plan";
export { ROW_GROUPS, rowGroup, type RowGroup } from "./groups";
export {
  DEFAULT_DOWNLOAD_CONCURRENCY,
  describeDownloadError,
  runImport,
  type ImportSummary,
  type RowProgress,
  type RunnerDeps,
  type SummarySkipReason,
} from "./runner";
export {
  extractModMetadata,
  isModJar,
  loadIconFromJar,
  type ModMetadata,
} from "./modMetadata";
export {
  sha1Hex,
  sha256Hex,
  sha512Hex,
  trySha512Hex,
  verifyWithWebCrypto,
  type ExpectedHashes,
  type HashCheck,
} from "./hashing";
export {
  getProjects,
  getVersionsFromHashes,
  MODRINTH_API_BASE,
  type ModrinthClientConfig,
  type ModrinthFile,
  type ModrinthProjectDetails,
  type ModrinthVersion,
} from "./modrinth";
