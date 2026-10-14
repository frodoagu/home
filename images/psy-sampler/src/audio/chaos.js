// Deterministic chaos: the Lorenz attractor, integrated with 4th-order
// Runge-Kutta. It stays bounded and never repeats, so a modulation drawn from
// it wanders like no periodic LFO. The insert's "chaos" LFO shape reads it at
// control rate, and fx.chaos at audio rate. Fixed parameters and starting
// point: every page draws the same orbit, so a WAV export sounds the same.

export const SIGMA = 10;
export const RHO = 28;
export const BETA = 8 / 3;
// Time units of one turn around a lobe, roughly: a "cycle" of the LFO.
export const LOBE = 0.75;
const START = [1, 1, 1];
const SETTLE = 2000; // steps dropped while the orbit falls onto the attractor

const deriv = (x, y, z) => [SIGMA * (y - x), x * (RHO - z) - y, x * y - BETA * z];

/** One RK4 step of `dt` from [x, y, z]. */
export function rk4([x, y, z], dt) {
  const k1 = deriv(x, y, z);
  const k2 = deriv(x + (dt / 2) * k1[0], y + (dt / 2) * k1[1], z + (dt / 2) * k1[2]);
  const k3 = deriv(x + (dt / 2) * k2[0], y + (dt / 2) * k2[1], z + (dt / 2) * k2[2]);
  const k4 = deriv(x + dt * k3[0], y + dt * k3[1], z + dt * k3[2]);
  return [0, 1, 2].map((i) => [x, y, z][i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/**
 * `n` points of the orbit, `dt` apart, as { x, y, z } Float32Arrays, each
 * centred and scaled into -1..1.
 */
export function lorenz(n, dt) {
  let p = START;
  for (let i = 0; i < SETTLE; i++) p = rk4(p, 0.005);
  const out = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    out.x[i] = p[0];
    out.y[i] = p[1];
    out.z[i] = p[2];
    p = rk4(p, dt);
  }
  for (const axis of Object.values(out)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of axis) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2 || 1;
    for (let i = 0; i < n; i++) axis[i] = (axis[i] - mid) / half;
  }
  return out;
}
