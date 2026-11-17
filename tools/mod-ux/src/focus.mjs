// A record of which app was in front and where the pointer was while a run had the desktop, so
// "it didn't take your focus" is measured rather than claimed. It reads only those two facts.
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from './process.mjs';

const SAMPLE = 'ObjC.import("AppKit"); var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; var p = $.NSEvent.mouseLocation; JSON.stringify({ app: a.bundleIdentifier.js, x: Math.round(p.x), y: Math.round(p.y) })';

/**
 * Samples until stop() is called, which resolves to the samples and a summary.
 * @param {{ executeCommand?: Function, intervalMs?: number, now?: () => number }} [options]
 */
export function watchFocus({ executeCommand = execute, intervalMs = 500, now = Date.now } = {}) {
  const samples = [];
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const sample = JSON.parse((await executeCommand(['osascript', '-l', 'JavaScript', '-e', SAMPLE], { timeoutMs: 5000 })).stdout.trim());
        samples.push({ at: now(), ...sample });
      } catch {} // A missed sample is a gap, not a failure of the run.
      try { await delay(intervalMs, undefined, { signal: controller.signal }); } catch {}
    }
  })();
  return {
    async stop() {
      controller.abort();
      await done;
      return { samples, summary: summarizeFocus(samples) };
    },
  };
}

/** Which apps came to the front, and whether the pointer moved, between consecutive samples. */
export function summarizeFocus(samples) {
  const changes = [];
  let moves = 0;
  for (let index = 1; index < samples.length; index++) {
    const [before, after] = [samples[index - 1], samples[index]];
    if (before.app !== after.app) changes.push({ atMs: after.at - samples[0].at, from: before.app, to: after.app });
    if (before.x !== after.x || before.y !== after.y) moves++;
  }
  return {
    samples: samples.length,
    durationMs: samples.length ? samples.at(-1).at - samples[0].at : 0,
    frontAtStart: samples[0]?.app ?? null,
    frontChanges: changes,
    claudeCameToFront: changes.filter(change => change.to === 'com.anthropic.claudefordesktop').length,
    pointerMoves: moves,
    note: 'Pointer moves include your own; a change of front app may be yours too.',
  };
}
