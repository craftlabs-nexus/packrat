/** The message of a caught value of unknown type. */
export function getErrorMessage(e: unknown, fallback = "Unknown error"): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return fallback;
}

/** The last segment of a "/"-separated path (the whole path when it has no "/"). */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
