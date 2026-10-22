/**
 * A tiny concurrency limiter: at most `n` of the wrapped tasks run at once,
 * the rest wait in FIFO order.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(n: number): Limiter {
  const max = Math.max(1, Math.floor(n));
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    if (active >= max) return;
    const start = queue.shift();
    if (start) start();
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
