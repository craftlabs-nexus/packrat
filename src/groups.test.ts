import { describe, expect, it } from "vitest";
import { ROW_GROUPS, rowGroup } from "./groups";
import type { ReviewRow, ReviewStatus } from "./types";

function rowWith(status: ReviewStatus): ReviewRow {
  return {
    entry: { key: "k", filename: "k" },
    status,
    selectable: false,
    selected: false,
    title: "k",
  };
}

describe("rowGroup", () => {
  it("maps every status to a listed group", () => {
    const groups = new Set(ROW_GROUPS.map((g) => g.group));
    const statuses: ReviewStatus[] = [
      { kind: "import" },
      { kind: "import", tagsOnly: true },
      { kind: "unresolvable", reason: "x" },
      { kind: "skip", reason: "client-only" },
      { kind: "skip", reason: "optional" },
      { kind: "skip", reason: "already-imported" },
      { kind: "skip", reason: "duplicate-in-pack" },
      { kind: "skip", reason: "no-items" },
    ];
    for (const s of statuses) expect(groups.has(rowGroup(rowWith(s)))).toBe(true);
    expect(rowGroup(rowWith({ kind: "import" }))).toBe("import");
    expect(rowGroup(rowWith({ kind: "import", tagsOnly: true }))).toBe("tags-only");
    expect(rowGroup(rowWith({ kind: "skip", reason: "no-items" }))).toBe("no-items");
  });
});
