// The order in which a recording went through the app's screens, and a follower that checks a
// replay against the captured order while it runs. JS samples arrive about once a second.

const UNKNOWN_SCREEN = '(unknown)';
// A screen counts as visited after this many samples in a row; a shorter stay is a transition.
const VISIT_SAMPLES = 2;
// A replay has left the path once another screen stays this long (one more sample of slack).
const OFF_PATH_SAMPLES = 3;
// A replay may pass a visited screen faster than the capture did and land on the one after it.
const MAX_SKIPPED = 1;

const isKnown = screen => Boolean(screen) && screen !== UNKNOWN_SCREEN;

export function screenPath(screens) {
  const path = [];
  let current = null;
  let count = 0;
  const flush = () => {
    if (current && count >= VISIT_SAMPLES && path[path.length - 1] !== current) path.push(current);
  };
  for (const screen of screens) {
    if (!isKnown(screen)) continue;
    if (screen === current) {
      count += 1;
      continue;
    }
    flush();
    current = screen;
    count = 1;
  }
  flush();
  return path;
}

export function followScreenPath(expected) {
  let index = 0;
  let candidate = null;
  let count = 0;
  let offPath = null;
  return {
    // Feeds the screen of the next sample; returns the screen the replay left the path for, if any.
    see(screen) {
      if (offPath || !isKnown(screen)) return offPath;
      if (screen === expected[index]) {
        candidate = null;
        count = 0;
        return null;
      }
      if (screen !== candidate) {
        candidate = screen;
        count = 0;
      }
      count += 1;
      const ahead = expected.indexOf(screen, index + 1);
      if (ahead !== -1 && ahead <= index + 1 + MAX_SKIPPED) {
        if (count >= VISIT_SAMPLES) {
          index = ahead;
          candidate = null;
          count = 0;
        }
        return null;
      }
      if (count >= OFF_PATH_SAMPLES) offPath = screen;
      return offPath;
    },
    offPath: () => offPath,
    // The screens of the path the replay has not reached yet.
    missing: () => expected.slice(index + 1)
  };
}
