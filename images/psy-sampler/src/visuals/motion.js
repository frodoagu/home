// How the beat moves the picture. Each kick (and, less, each bass note)
// throws it forward: a velocity that eases in over ATTACK_MS and that
// friction brakes over FRICTION_MS. `push` is the distance travelled, so it
// only ever goes forward, and the scenes move along it (a flight, a current,
// a growth). An envelope added to a position instead snaps out on the hit and
// slides back after it: a broken boomerang. `surge` is the velocity itself,
// for what may swell with the speed.
//
// `heart` beats on each kick: a lub HEART_MS·2 after it and a softer dub
// DUB of a beat later, each a pulse that leaves and returns to 0 with no
// speed (t²·e^-t), so it may scale a shape where an envelope would snap.
// It is summed from the hits' own times, so it lands the same at any frame
// rate.
//
// Kicks near a drop also shake the camera: a tremor that eases in, dies out
// over SHAKE_MS and fades away over the bars after the drop.

const FRICTION_MS = 380;
const ATTACK_MS = 60;
const SHAKE_MS = 170;
const SHAKE_ATTACK_MS = 15;
export const SHAKE_MAX = 0.005; // of the screen's short side
const THROW = { kick: 1, bass: 0.15 };
const ACCENT = 1.3;
const DROP_BEATS = 8;
const FAR_SHAKE = 0.12; // a kick far from any drop shakes this much of a drop's
const HEART_MS = 35;
const DUB = 0.4; // of a beat after the lub
const DUB_LEVEL = 0.6;

/** How far `hit` throws the picture at frame `s`: further the deeper it is (an accent, a loud low end). */
export function throwOf(hit, s) {
  const deep = 0.55 + 0.9 * Math.min(1, s.levels.low);
  return (THROW[hit.layer] ?? 0) * (hit.layer === "kick" && hit.accent ? ACCENT : 1) * deep;
}

// Two sines a little out of step: a wobble that never quite repeats.
const wobble = (t, hz, phase) => 0.6 * Math.sin(t * hz * 2 * Math.PI + phase) + 0.4 * Math.sin(t * hz * 3.6 + phase * 2.1);

/** One heartbeat `ms` after it starts: 0 with no slope at 0, 1 at its peak (2·HEART_MS). */
export function pulse(ms) {
  if (ms <= 0) return 0;
  const x = ms / (2 * HEART_MS);
  return x * x * Math.exp(2 - 2 * x);
}

/** step(frame) once per stage frame: { push, surge, heart, shake: [x, y, turn] }. */
export function createMotion({ shake: shakes = true } = {}) {
  let at = null;
  let drive = 0; // the velocity a hit asks for, braked by friction
  let surge = 0; // the velocity, easing towards drive
  let push = 0;
  let quake = 0;
  let tremor = 0; // quake, eased
  let beats = []; // { time, level }: the heart's pulses still ringing

  return function step(s) {
    const dt = at === null ? 0 : Math.min(100, Math.max(0, s.time - at));
    at = s.time;
    for (const hit of s.hits) {
      const k = throwOf(hit, s);
      if (!k) continue;
      drive += k;
      if (hit.layer === "kick") {
        const level = Math.min(1, k);
        beats.push({ time: hit.time, level }, { time: hit.time + DUB * s.beatMs, level: level * DUB_LEVEL });
      }
      if (hit.layer === "kick" && shakes) {
        const near = s.sinceDrop >= 0 ? Math.exp(-s.sinceDrop / DROP_BEATS) : 0;
        quake = Math.max(quake, Math.min(1, k) * (FAR_SHAKE + (1 - FAR_SHAKE) * near));
      }
    }
    drive *= Math.exp(-dt / FRICTION_MS);
    surge += (drive - surge) * (1 - Math.exp(-dt / ATTACK_MS));
    push += (surge * dt) / FRICTION_MS;
    quake *= Math.exp(-dt / SHAKE_MS);
    tremor += (quake - tremor) * (1 - Math.exp(-dt / SHAKE_ATTACK_MS));
    beats = beats.filter((b) => s.time - b.time < 20 * HEART_MS);
    const heart = beats.reduce((sum, b) => sum + b.level * pulse(s.time - b.time), 0);

    const amp = SHAKE_MAX * tremor;
    const sec = s.time / 1000;
    return {
      push,
      surge: Math.min(1.5, surge),
      heart: Math.min(1.5, heart),
      shake: [amp * wobble(sec, 9, 0), amp * wobble(sec, 8.3, 1.7), 0.8 * amp * wobble(sec, 6.1, 4.2)],
    };
  };
}
