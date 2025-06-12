import type { AbortSignal } from "node_modules/grammy/out/shim.node";

export function cancellableInterval<TArgs extends any[]>(
  callback: (...args: TArgs) => void,
  delay: number,
  signal: AbortSignal,
  ...args: TArgs
) {
  let intervalId: NodeJS.Timeout;

  intervalId = setInterval(() => {
    if (signal.aborted) {
      clearInterval(intervalId);
      return;
    }
    callback(...args);
  }, delay);
}
