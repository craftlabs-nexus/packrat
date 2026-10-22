import { describe, expect, it } from "vitest";
import * as packrat from "./index";
import type {
  BlockedReason,
  ModsFolderResult,
  ResolveDeps,
  ResolvedModrinth,
  ResolveInput,
  ResolveOptions,
  RunOptions,
} from "./index";

describe("the package entry point", () => {
  it("exports the URL helpers and the stages", () => {
    for (const name of [
      "parseWebUrl",
      "isMixedContent",
      "isInternalHost",
      "isPrivateIp",
      "describeBlockedDownload",
      "fetchRows",
      "runImport",
      "itemContentRule",
      "verifyWithWebCrypto",
    ]) {
      expect(typeof (packrat as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("exports the types its signatures use", () => {
    const reason: BlockedReason = "host-no-cors";
    const input: ResolveInput = { key: "k" };
    const resolved: ResolvedModrinth = { projectId: "P" };
    const options: ResolveOptions & RunOptions = { signal: new AbortController().signal };
    const deps: Partial<ResolveDeps> = {};
    const folder: Partial<ModsFolderResult> = { candidates: [] };
    expect([reason, input, resolved, options, deps, folder]).toHaveLength(6);
  });
});
