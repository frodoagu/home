// Scenes that carry a state from frame to frame: a simulation stepped in
// float textures before the scene draws, which reads it as uState.
//
//   turing     Gray-Scott reaction-diffusion: a ping-pong pair of A/B fields
//   physarum   slime mould: agents (a float texture: x, y, heading) smell a
//              trail, move, and drop onto it as points; the trail blurs and
//              fades
//
// Both need float render targets (EXT_color_buffer_float). A scene that
// comes in starts from a fresh state, so it grows on screen every time.

import { PHYSARUM_AGENTS, PHYSARUM_DEPOSIT, PHYSARUM_DIFFUSE, PHYSARUM_POINTS, TURING_STEP } from "./shaders.js";

// Steps per second of show time, and the most one frame may take.
export const RATES = { turing: { perSecond: 900, max: 24 }, physarum: { perSecond: 75, max: 3 } };
const TURING_ROWS = 256;
const TRAIL_ROWS = 360;
const AGENTS = [512, 256];

/**
 * The steps to take for `seconds` of show time at `rate`, carrying the
 * fraction to the next frame (and dropping what a capped frame could not
 * take): { steps, carry }.
 */
export function stepsFor(rate, seconds, carry = 0) {
  const want = carry + Math.max(0, seconds) * rate.perSecond;
  const steps = Math.min(rate.max, Math.floor(want));
  return { steps, carry: Math.min(want - steps, 1) };
}

/**
 * `kit` is the renderer's plumbing: { gl, link, use, sampler, setAll, target,
 * release, draw }. Returns null where float targets can't be drawn into.
 */
export function createSims(kit) {
  const { gl } = kit;
  if (!gl.getExtension("EXT_color_buffer_float")) return null;
  const programs = {
    turing: kit.link(TURING_STEP),
    agents: kit.link(PHYSARUM_AGENTS),
    deposit: kit.link(PHYSARUM_DEPOSIT, PHYSARUM_POINTS),
    diffuse: kit.link(PHYSARUM_DIFFUSE),
  };
  const points = gl.createVertexArray(); // no attributes: the vertex shader reads the agents
  const exact = { internal: gl.RGBA32F, type: gl.FLOAT, filter: gl.NEAREST, wrap: gl.REPEAT };
  const soft = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR, wrap: gl.REPEAT };
  let aspect = 0;
  let live = {}; // id -> its textures, carry and step count

  function make(id) {
    const rows = id === "turing" ? TURING_ROWS : TRAIL_ROWS;
    const cols = Math.max(16, Math.round(rows * aspect));
    if (id === "turing") return { field: [kit.target(cols, rows, exact), kit.target(cols, rows, exact)] };
    return {
      agents: [kit.target(...AGENTS, exact), kit.target(...AGENTS, exact)],
      trail: [kit.target(cols, rows, soft), kit.target(cols, rows, soft)],
    };
  }

  function free(sim) {
    for (const t of [...(sim.field ?? []), ...(sim.agents ?? []), ...(sim.trail ?? [])]) kit.release(t);
  }

  function turing(sim, uniforms, steps, reset) {
    const p = programs.turing;
    kit.use(p, "turing");
    kit.setAll(p, uniforms);
    for (let i = 0; i < steps; i++) {
      kit.sampler(p, "uState", 0, sim.field[0]);
      kit.setAll(p, { uReset: reset && i === 0 ? 1 : 0 });
      kit.draw(sim.field[1]);
      sim.field.reverse();
    }
    return sim.field[0];
  }

  function physarum(sim, uniforms, steps, reset) {
    const { agents, deposit, diffuse } = programs;
    if (reset) {
      for (const t of sim.trail) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    for (let i = 0; i < steps; i++) {
      kit.use(agents, "physarum agents");
      kit.setAll(agents, { ...uniforms, uReset: reset && i === 0 ? 1 : 0, uStep: (sim.count = (sim.count ?? 0) + 1) % 4096 });
      kit.sampler(agents, "uAgents", 0, sim.agents[0]);
      kit.sampler(agents, "uTrail", 1, sim.trail[0]);
      kit.draw(sim.agents[1]);
      sim.agents.reverse();

      kit.use(deposit, "physarum deposit");
      kit.sampler(deposit, "uAgents", 0, sim.agents[0]);
      kit.setAll(deposit, { uDeposit: 1 + 2 * uniforms.uKick });
      gl.bindFramebuffer(gl.FRAMEBUFFER, sim.trail[0].fb);
      gl.viewport(0, 0, sim.trail[0].w, sim.trail[0].h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(points);
      gl.drawArrays(gl.POINTS, 0, AGENTS[0] * AGENTS[1]);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);

      kit.use(diffuse, "physarum diffuse");
      kit.sampler(diffuse, "uTrail", 0, sim.trail[0]);
      kit.draw(sim.trail[1]);
      sim.trail.reverse();
    }
    return sim.trail[0];
  }

  return {
    has: (id) => id in RATES,
    /** The canvas changed shape: every state starts over at the new one. */
    resize(w, h) {
      if (Math.abs(w / h - aspect) < 1e-3) return;
      aspect = w / h;
      for (const sim of Object.values(live)) free(sim);
      live = {};
    },
    /**
     * Steps scene `id` for `seconds` of show time (from scratch when `fresh`)
     * and returns the texture its scene reads.
     */
    advance(id, uniforms, seconds, fresh) {
      let sim = live[id];
      if (!sim) sim = live[id] = make(id);
      const reset = fresh || !sim.started;
      const { steps, carry } = stepsFor(RATES[id], seconds, sim.carry);
      sim.carry = carry;
      const n = reset ? Math.max(1, steps) : steps;
      sim.started = true;
      return id === "turing" ? turing(sim, uniforms, n, reset) : physarum(sim, uniforms, n, reset);
    },
    destroy() {
      for (const sim of Object.values(live)) free(sim);
      live = {};
    },
  };
}
