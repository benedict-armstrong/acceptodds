import { settle } from './map-layout';

/**
 * Runs `settle` off the main thread, so the map stays smooth while a subset
 * is laid out again. One job at a time: a newer request (or `{ id, stop }`)
 * ends the current one between frames. Frames go back with their buffers
 * transferred, not copied.
 */

export type LayoutRequest =
  | {
      id: number;
      start: Float32Array;
      related: [number, number][];
      /** The supplier's cluster per point, -1 for none. */
      groups: Int32Array;
    }
  | { id: number; stop: true };
export type LayoutFrame = { id: number; positions: Float32Array; settled: boolean };

let current = 0;

self.onmessage = async (e: MessageEvent<LayoutRequest>) => {
  const job = e.data;
  current = job.id;
  if ('stop' in job) return;
  const frames = settle(job.start, job.related, job.groups);
  let next = frames.next();
  while (!next.done) {
    const following = frames.next();
    const frame: LayoutFrame = { id: job.id, positions: next.value, settled: following.done === true };
    self.postMessage(frame, { transfer: [frame.positions.buffer] });
    next = following;
    // Let a newer request in between frames.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (current !== job.id) return;
  }
};
