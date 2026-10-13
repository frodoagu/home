// WebGL2 plumbing for the show: one program per scene plus the bloom
// (BLOOM + BLUR), POST and FINAL, drawn as a full-screen triangle pair.
//
//   scene ──> target "scene" ──> BLOOM ─> BLUR ×4 ─> "bloom" ┐
//   previous scene ──> "prev"                                ┼─> POST ──> feed[i] ──> FINAL ──> canvas
//   feed[1-i] (last frame) ──────────────────────────────────┘           (FXAA, grain)
//
// Scenes with a simulation (sims.js) step it first and read its state.
//
// Scenes render below the canvas resolution: `level` (0..1) sets both that
// fraction and the raymarch steps, and adapt() moves it with the frame time,
// so a weak GPU (a phone, a TV) gets a softer picture instead of a slideshow.

import { BLOOM, BLUR, FINAL, POST, VERTEX, sceneSource } from "./shaders.js";
import { RATES, createSims } from "./sims.js";

const MAX_PIXELS = 1920 * 1080; // the canvas never goes past this, whatever the screen
const SLOW_MS = 22; // frame time above this: drop a notch
const FAST_MS = 18; // below this for RISE_MS: go up a notch
const RISE_MS = 1500;
const INTS = new Set(["uPalette"]);
const STATE_UNIT = 5; // where a scene reads its simulation, clear of POST's

export const scaleOf = (level) => 0.3 + 0.7 * level ** 0.8;

/**
 * The next level after a frame that took `dt` ms. `state` is { level, ema,
 * fastFor }: the frame time's moving average and how long it has stayed fast.
 */
export function adapt(state, dt) {
  const ema = state.ema + (Math.min(dt, 100) - state.ema) * 0.08;
  let { level, fastFor } = state;
  if (ema > SLOW_MS) {
    level = Math.max(0, level - 0.004 * (ema - SLOW_MS));
    fastFor = 0;
  } else if (ema < FAST_MS) {
    fastFor += dt;
    if (fastFor > RISE_MS) level = Math.min(1, level + 0.002);
  } else fastFor = 0;
  return { level, ema, fastFor };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

function link(gl, fragment, vertex = VERTEX) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  return { program, vs, fs, locations: new Map() };
}

// Checked lazily: asking right after linking would stall on parallel compiles.
function check(gl, p, name) {
  if (gl.getProgramParameter(p.program, gl.LINK_STATUS)) return;
  const log = gl.getShaderInfoLog(p.fs) || gl.getProgramInfoLog(p.program);
  throw new Error(`shader ${name}: ${log}`);
}

// A texture to draw into: RGBA8, bilinear and clamped unless `opts` says otherwise.
function target(gl, w, h, opts = {}) {
  const { internal = gl.RGBA8, type = gl.UNSIGNED_BYTE, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = opts;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { texture, fb, w, h };
}

/** null where there is no WebGL2. */
export function createRenderer(canvas, { sceneIds, level = 0.75 } = {}) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;
  let lost = false;
  let programs = null;
  let targets = null;
  let flip = 0;
  let quality = { level, ema: 16, fastFor: 0 };
  let sims = null;
  let painted = new Set(); // the scenes drawn last frame: any other comes in fresh

  function build() {
    gl.getExtension("KHR_parallel_shader_compile");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    programs = {
      scenes: Object.fromEntries(sceneIds.map((id) => [id, link(gl, sceneSource(id))])),
      post: link(gl, POST),
      bloom: link(gl, BLOOM),
      blur: link(gl, BLUR),
      final: link(gl, FINAL),
    };
    targets = null;
    sims = createSims({ gl, link: (fs, vs) => link(gl, fs, vs), use, sampler, setAll, target: (w, h, o) => target(gl, w, h, o), release, draw });
    painted = new Set();
  }

  function release(t) {
    gl.deleteTexture(t.texture);
    gl.deleteFramebuffer(t.fb);
  }

  function use(p, name) {
    if (!p.checked) {
      check(gl, p, name);
      p.checked = true;
    }
    gl.useProgram(p.program);
  }

  function locate(p, name) {
    let loc = p.locations.get(name);
    if (loc === undefined) {
      loc = gl.getUniformLocation(p.program, name);
      p.locations.set(name, loc);
    }
    return loc;
  }

  // Texture `t` on `unit`, read by sampler `name`.
  function sampler(p, name, unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.texture);
    gl.uniform1i(locate(p, name), unit);
  }

  function set(p, name, value) {
    const loc = locate(p, name);
    if (loc === null) return;
    if (INTS.has(name)) gl.uniform1i(loc, value);
    else if (typeof value === "number") gl.uniform1f(loc, value);
    else if (value.length === 2) gl.uniform2fv(loc, value);
    else if (value.length === 3) gl.uniform3fv(loc, value);
    else gl.uniform4fv(loc, value);
  }

  function setAll(p, uniforms) {
    for (const [name, value] of Object.entries(uniforms)) set(p, name, value);
  }

  // Canvas at the screen's resolution (capped), targets at the level's share.
  function size() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    let w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    let h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const over = Math.sqrt((w * h) / MAX_PIXELS);
    if (over > 1) {
      w = Math.round(w / over);
      h = Math.round(h / over);
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const s = scaleOf(quality.level);
    const tw = Math.max(16, Math.round(w * s));
    const th = Math.max(16, Math.round(h * s));
    // Small swings keep their targets: re-allocating every frame would stutter.
    if (targets && Math.abs(targets.scene.w - tw) / tw < 0.08 && targets.w === w && targets.h === h) return;
    if (targets) {
      for (const t of [targets.scene, targets.prev, ...targets.feed, ...targets.bloom]) release(t);
    }
    sims?.resize(w, h);
    const make = () => target(gl, tw, th);
    const quarter = () => target(gl, Math.max(8, Math.round(tw / 4)), Math.max(8, Math.round(th / 4)));
    targets = { w, h, scene: make(), prev: make(), feed: [make(), make()], bloom: [quarter(), quarter()] };
  }

  function draw(into) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fb : null);
    gl.viewport(0, 0, into ? into.w : canvas.width, into ? into.h : canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * One frame. `frame` has the shared uniforms (uTime, uBeats, uKick...),
   * `scene` / `previous` are { id, palette, vars }, `post` POST's own, and
   * `seconds` the show time since the last frame, which steps the
   * simulations.
   */
  function render({ uniforms, scene, previous, post, seconds = 0 }) {
    if (lost) return;
    size();
    const res = [targets.scene.w, targets.scene.h];
    const shared = { ...uniforms, uRes: res, uQuality: quality.level };
    const drawn = new Set();
    const paint = (look, into) => {
      const p = programs.scenes[look.id];
      const own = { ...shared, uPalette: look.palette, uVar: look.vars };
      const state = sims?.has(look.id) ? sims.advance(look.id, own, seconds, !painted.has(look.id)) : null;
      use(p, look.id);
      setAll(p, own);
      if (state) sampler(p, "uState", STATE_UNIT, state);
      draw(into);
      drawn.add(look.id);
    };
    paint(scene, targets.scene);
    if (previous) paint(previous, targets.prev);
    painted = drawn;

    // Bloom: the scene's bright parts at a quarter size, blurred twice each
    // way, the second time twice as wide.
    const [b0, b1] = targets.bloom;
    use(programs.bloom, "bloom");
    sampler(programs.bloom, "uTex", 0, targets.scene);
    set(programs.bloom, "uTexel", [1 / targets.scene.w, 1 / targets.scene.h]);
    draw(b0);
    use(programs.blur, "blur");
    for (const spread of [1, 2]) {
      sampler(programs.blur, "uTex", 0, b0);
      set(programs.blur, "uDir", [spread / b0.w, 0]);
      draw(b1);
      sampler(programs.blur, "uTex", 0, b1);
      set(programs.blur, "uDir", [0, spread / b1.h]);
      draw(b0);
    }

    const out = targets.feed[flip];
    const last = targets.feed[1 - flip];
    const { post: pp, final } = programs;
    use(pp, "post");
    sampler(pp, "uScene", 0, targets.scene);
    sampler(pp, "uPrev", 1, previous ? targets.prev : targets.scene);
    sampler(pp, "uFeed", 2, last);
    sampler(pp, "uBloom", 3, b0);
    setAll(pp, {
      ...shared,
      uPalette: scene.palette,
      uVar: scene.vars,
      ...post,
      uMix: previous ? post.uMix : 1,
    });
    draw(out);

    use(final, "final");
    sampler(final, "uTex", 0, out);
    setAll(final, { uTexel: [1 / out.w, 1 / out.h], uRes: [canvas.width, canvas.height], uTime: uniforms.uTime, uGrain: post.uGrain ?? 0 });
    draw(null);
    flip = 1 - flip;
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
    build();
  });

  build();
  return {
    render,
    /** Feeds the frame time (ms) to the quality control. */
    adapt: (dt) => {
      quality = adapt(quality, dt);
    },
    level: () => quality.level,
    /** Whether scene `id` can be drawn here: the simulations need float targets. */
    supports: (id) => Boolean(sims) || !(id in RATES),
    destroy: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
  };
}
