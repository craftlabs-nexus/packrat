/**
 * Review groups: how the review step and the store bucket plan rows.
 */
import type { ReviewRow } from "./types";

export type RowGroup =
  | "import"
  | "tags-only"
  | "client-only"
  | "optional"
  | "already-imported"
  | "duplicate-in-pack"
  | "no-items"
  | "unresolvable";

/** Display order and default labels of the review groups (CategoryCraft's wording). */
export const DEFAULT_ROW_GROUP_LABELS: { group: RowGroup; label: string }[] = [
  { group: "import", label: "Will import" },
  { group: "tags-only", label: "Will import tags only (no items)" },
  { group: "client-only", label: "Client-only" },
  { group: "optional", label: "Optional" },
  { group: "already-imported", label: "Already imported" },
  { group: "duplicate-in-pack", label: "Duplicates in this pack" },
  { group: "no-items", label: "No items (library or data)" },
  { group: "unresolvable", label: "Unresolvable" },
];

export function rowGroup(row: ReviewRow): RowGroup {
  const { status } = row;
  if (status.kind === "import") return status.tagsOnly ? "tags-only" : "import";
  if (status.kind === "unresolvable") return "unresolvable";
  return status.reason;
}
