/**
 * Packrat: read a Minecraft modpack (a launcher folder, an .mrpack, a
 * CurseForge zip, a packwiz URL), plan its import and fetch its JARs.
 * See README.md.
 */
export * from "./types";
export { scanJar, isJarFilename } from "./jarScan";
export {
  analyzeFolder,
  findModsFolder,
  type AnalyzeFolderOptions,
  fromDropzoneFiles,
  fromFileList,
  type LocalFile,
  type ModsFolderResult,
} from "./sources/folder";
export { analyzeMrpack } from "./sources/mrpack";
export { analyzeCurseforgeZip } from "./sources/curseforge";
export {
  analyzeModsZip,
  analyzePackZip,
  detectPackZip,
  type PackZipKind,
} from "./sources/detect";
export {
  analyzePackwiz,
  validatePackUrl,
  type FetchImpl,
  type PackwizOptions,
} from "./sources/packwiz";
export {
  classifyDownloadUrl,
  currentPageProtocol,
  describeBlockedDownload,
  isInternalHost,
  isMixedContent,
  isPrivateIp,
  KNOWN_BLOCKED_HOSTS,
  KNOWN_GOOD_HOSTS,
  parseWebUrl,
  type BlockedReason,
  type ClassifyContext,
  type UrlVerdict,
} from "./downloadUrl";
export { createLimiter, type Limiter } from "./limiter";
export {
  resolveModrinth,
  type ResolveDeps,
  type ResolvedModrinth,
  type ResolveInput,
  type ResolveOptions,
  type ResolveResult,
} from "./modrinthResolve";
export {
  buildPlan,
  itemContentRule,
  proposeVersionAction,
  sourceDisplayName,
  type BuildPlanContext,
  type BundledVersionRef,
  type ContentRule,
} from "./plan";
export { DEFAULT_ROW_GROUP_LABELS, rowGroup, type RowGroup } from "./groups";
export {
  DEFAULT_DOWNLOAD_CONCURRENCY,
  describeDownloadError,
  fetchRows,
  runImport,
  type CommitResult,
  type FailedRow,
  type FetchDeps,
  type FetchedRow,
  type FetchOptions,
  type FetchRowsRun,
  type FetchSummary,
  type ImportSummary,
  type RowProgress,
  type RunnerDeps,
  type RunOptions,
  type SkippedRow,
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
