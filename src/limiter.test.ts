import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter";

describe("createLimiter", () => {
  it("runs at most n tasks at once, in order, and passes results through", async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        limit(async () => {
          started.push(i);
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
          return i * 10;
        }),
      ),
    );
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps going after a rejected task", async () => {
    const limit = createLimiter(1);
    const a = limit(async () => {
      throw new Error("boom");
    });
    const b = limit(async () => "ok");
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe("ok");
  });

  it("frees the slot of a task that throws synchronously", async () => {
    const limit = createLimiter(1);
    const a = limit((() => {
      throw new Error("sync");
    }) as () => Promise<never>);
    await expect(a).rejects.toThrow("sync");
    await expect(limit(async () => "next")).resolves.toBe("next");
  });
});
