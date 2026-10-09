// Grid + lookahead math, kept free of Web Audio so it can be unit-tested.

export const LOOP_STEPS = 32; // 2 bars of 16ths
export const BAR_STEPS = 16;
export const TICK_MS = 25; // setInterval period of the scheduler
export const LOOKAHEAD = 0.12; // seconds scheduled ahead of ctx.currentTime
// Minimum lead for anything scheduled. A note whose start time is already past
// when the audio thread sees it starts mid-envelope (non-zero gain): a click.
export const SAFETY = 0.015;

export const BPM_MIN = 130;
export const BPM_MAX = 180;
export const BPM_DEFAULT = 145;

// One 16th note.
export const stepDuration = (bpm) => 60 / bpm / 4;

/**
 * One scheduler tick. `cursor` is the next step still to be scheduled and its
 * start time; returns every step that starts before `now + lookahead` and the
 * cursor for the following tick.
 *
 * The next step's time is always previous time + the step duration in force
 * when that previous step was scheduled, so a BPM change only stretches steps
 * from the cursor on: nothing already queued moves and the grid never drifts.
 */
export function collectSteps(cursor, now, lookahead, stepDur) {
  let { step, time } = cursor;

  // A throttled timer (background tab: >= 1 s per tick) leaves the cursor in
  // the past. Scheduling that backlog would fire it all at once; instead skip
  // whole steps so the next one lands back on the original grid phase.
  if (time < now + SAFETY) {
    const missed = Math.ceil((now + SAFETY - time) / stepDur);
    step = (step + missed) % LOOP_STEPS;
    time += missed * stepDur;
  }

  const due = [];
  while (time < now + lookahead) {
    due.push({ step, time });
    time += stepDur;
    step = (step + 1) % LOOP_STEPS;
  }
  return { due, cursor: { step, time } };
}

// Start time of the first beat (quarter note) at or after the cursor, used to
// drop one-shot FX on the grid while the loop runs.
export function nextBeatTime(cursor, stepDur) {
  const toBeat = (4 - (cursor.step % 4)) % 4;
  return cursor.time + toBeat * stepDur;
}
