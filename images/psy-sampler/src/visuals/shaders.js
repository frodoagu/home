// GLSL (WebGL2) for the show. Every scene is a full-screen fragment shader:
// the 3D ones raymarch a distance field, the 2D ones fold the plane. They all
// share COMMON's uniforms, which renderer.js sets from a stage frame:
//
//   uTime     seconds, running faster the busier the mix
//   uBeats    beats since ▶ (uBeat, uBar: phase in the beat and the bar)
//   uKick ... each layer's envelope: 1 on its hit, decaying (stage.js DECAY)
//   uEnergy   how busy the mix is, uBuild the sweep into a drop, uDrop 1 on
//             the drop fading over a bar
//   uLow      the levels heard, low/mid/high; uMusic 1 while something
//             plays, fading to 0 at rest, where nothing may pulse on the beat
//   uVar      four numbers the director draws per scene: its variant
//   uPalette  0..PALETTES-1, uQuality 0..1 (raymarch steps, from the frame rate)
//
// POST mixes the scene with the previous one (a crossfade), its own last
// frame (trails), the laser layer behind them, the bloom (BLOOM + BLUR) and a
// haze lit by it, through a lens and a film grade, then the strobe. FINAL
// puts it on the canvas with FXAA and grain.

export const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime, uBeats, uBeat, uBar;
uniform float uKick, uBass, uPerc, uLead, uPad, uGlitch, uFx;
uniform float uEnergy, uBuild, uDrop, uQuality, uMusic;
uniform vec3 uLow;
uniform vec4 uVar;
uniform int uPalette;

#define TAU 6.28318531
#define PI 3.14159265

// Cosine palettes (iq): a + b * cos(TAU * (c * t + d)).
const vec3 PA[8] = vec3[8](vec3(.5), vec3(.5), vec3(.5), vec3(.5, .3, .6), vec3(.5, .2, .1), vec3(.5), vec3(.8, .5, .4), vec3(.2, .5, .5));
const vec3 PB[8] = vec3[8](vec3(.5), vec3(.5), vec3(.5), vec3(.5, .5, .4), vec3(.5, .35, .15), vec3(.5), vec3(.2, .4, .2), vec3(.4, .5, .5));
const vec3 PC[8] = vec3[8](vec3(1.), vec3(1.), vec3(1., 1., .5), vec3(1.), vec3(1.), vec3(2., 1., 0.), vec3(2., 1., 1.), vec3(1., 1., 1.));
const vec3 PD[8] = vec3[8](vec3(0., .33, .67), vec3(.3, .2, .2), vec3(.8, .9, .3), vec3(.6, 0., .3), vec3(0., .1, .2), vec3(.5, .2, .25), vec3(0., .25, .25), vec3(.55, .65, .75));

vec3 pal(float t) {
  return clamp(PA[uPalette] + PB[uPalette] * cos(TAU * (PC[uPalette] * t + PD[uPalette])), 0.0, 1.0);
}

mat2 rot(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * vec3(.1031, .1030, .0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

mat3 camera(vec3 ro, vec3 ta, float roll) {
  vec3 w = normalize(ta - ro);
  vec3 u = normalize(cross(w, vec3(sin(roll), cos(roll), 0.0)));
  vec3 v = cross(u, w);
  return mat3(u, v, w);
}

// The screen point, -1..1 on the short side.
vec2 screen() {
  return (vUv * uRes - 0.5 * uRes) / min(uRes.x, uRes.y) * 2.0;
}

int steps(float lo, float hi) {
  return int(mix(lo, hi, uQuality));
}

vec3 tone(vec3 c) {
  return 1.0 - exp(-c * 1.25);
}
`;

// A Mandelbulb seen from an orbit that breathes with the kick; its power
// drifts, so it slowly morphs between bulbs. Colour from an orbit trap.
const BULB = `
float bulb(vec3 p, out float trap) {
  vec3 z = p;
  float dr = 1.0, r = 0.0;
  float power = 8.0 + 2.0 * sin(uTime * 0.07 + uVar.x * TAU) + uBass * 0.4;
  trap = 1e9;
  for (int i = 0; i < 6; i++) {
    r = length(z);
    if (r > 2.0) break;
    float th = acos(clamp(z.z / r, -1.0, 1.0)) * power + uVar.y * 2.0;
    float ph = atan(z.y, z.x) * power + uTime * 0.05;
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    z = pow(r, power) * vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th)) + p;
    trap = min(trap, dot(z, z));
  }
  return 0.5 * log(max(r, 1e-4)) * r / dr;
}

float bulbD(vec3 p) {
  float t;
  return bulb(p, t);
}

vec3 normalBulb(vec3 p, float e) {
  vec2 k = vec2(1, -1);
  return normalize(k.xyy * bulbD(p + k.xyy * e) + k.yyx * bulbD(p + k.yyx * e) + k.yxy * bulbD(p + k.yxy * e) + k.xxx * bulbD(p + k.xxx * e));
}

vec3 scene(vec2 uv) {
  float t = uTime * 0.18 + uVar.z * TAU;
  float dist = 2.25 - 0.35 * uEnergy - 0.15 * uKick + 0.3 * sin(uTime * 0.05);
  vec3 ro = dist * vec3(sin(t), 0.45 * sin(t * 0.6 + uVar.y * TAU), cos(t));
  mat3 cam = camera(ro, vec3(0.0), 0.2 * sin(uTime * 0.1));
  vec3 rd = cam * normalize(vec3(uv, 1.7 + 0.25 * uKick));

  float r = length(uv);
  vec3 col = pal(0.7 + r * 0.25 + uTime * 0.02) * 0.07 * (1.2 - r * 0.5);
  col += pal(0.2 + uBeats * 0.03) * 0.25 * exp(-abs(r - 0.3 - fract(uBeat) * 1.5) * 12.0) * uKick;

  // Only inside the bulb's bounding sphere.
  float b = dot(ro, rd), c = dot(ro, ro) - 1.3 * 1.3, h = b * b - c;
  if (h < 0.0) return col;
  h = sqrt(h);
  float near = max(-b - h, 0.0), far = -b + h;
  float d = 0.0, trap = 0.0, glow = 0.0, x = near;
  int n = steps(50.0, 120.0), i;
  bool hit = false;
  for (i = 0; i < 140; i++) {
    if (i >= n) break;
    d = bulb(ro + rd * x, trap);
    glow += exp(-d * 30.0);
    if (d < 0.0007 * x) { hit = true; break; }
    x += d * 0.9;
    if (x > far) break;
  }
  vec3 g = pal(uTime * 0.03 + 0.5 + uVar.w) * glow * (0.012 + 0.03 * uKick + 0.02 * uLead);
  if (!hit) return col + g;
  vec3 p = ro + rd * x;
  vec3 nor = normalBulb(p, 0.0005 * x);
  vec3 light = normalize(vec3(0.6, 0.8, -0.5));
  float dif = clamp(dot(nor, light), 0.0, 1.0);
  float ao = 1.0 - float(i) / float(n);
  float rim = pow(1.0 - clamp(dot(-rd, nor), 0.0, 1.0), 3.0);
  vec3 base = pal(sqrt(trap) * 0.6 + uTime * 0.03 + uVar.w);
  vec3 lit = base * (0.15 + 1.1 * dif) * (0.4 + 0.6 * ao);
  lit += pal(sqrt(trap) * 0.6 + 0.5) * rim * (0.6 + uKick * 1.5);
  lit += base * uKick * 0.35 + base * uPerc * 0.1;
  return lit + g;
}
`;

// A flight down a tunnel bored through an infinite fractal: an Apollonian
// gasket or a kaleidoscopic fold (uVar.y), lit by a glow that rides the kick.
const KIFS = `
float apollo(vec3 p, out vec4 orb) {
  float s = 1.15 + 0.2 * uVar.x;
  float scale = 1.0;
  orb = vec4(1000.0);
  for (int i = 0; i < 7; i++) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float r2 = dot(p, p);
    orb = min(orb, vec4(abs(p), r2));
    float k = s / max(r2, 1e-4);
    p *= k;
    scale *= k;
  }
  return 0.25 * abs(p.y) / scale;
}

float folded(vec3 p, out vec4 orb) {
  p.z = mod(p.z, 2.0) - 1.0;
  float s = 1.0;
  orb = vec4(1000.0);
  for (int i = 0; i < 7; i++) {
    p = abs(p) - vec3(0.7, 0.55 + 0.2 * uVar.x, 0.35 + 0.3 * uVar.w);
    p.xy *= rot(0.35 + 0.25 * uVar.x + 0.05 * sin(uTime * 0.2));
    p.yz *= rot(0.5 + 0.2 * uVar.z + 0.04 * uBass);
    p *= 1.5;
    s *= 1.5;
    orb = min(orb, vec4(abs(p), dot(p, p)));
  }
  return (length(p.xy) - 0.4) / s;
}

vec2 path(float z) {
  return vec2(0.35 * sin(z * 0.21), 0.3 * cos(z * 0.17));
}

float tunnel(vec3 p, out vec4 orb) {
  float d = uVar.y < 0.5 ? apollo(p, orb) : folded(p, orb);
  float bore = 0.22 + 0.04 * uBass - length(p.xy - path(p.z));
  return max(d, bore);
}

float tunnelD(vec3 p) {
  vec4 o;
  return tunnel(p, o);
}

vec3 scene(vec2 uv) {
  float z = uTime * (0.45 + 0.35 * uEnergy);
  vec3 ro = vec3(path(z), z);
  vec3 ta = vec3(path(z + 1.0), z + 1.0);
  mat3 cam = camera(ro, ta, uTime * 0.12 + 0.6 * sin(uTime * 0.07));
  vec3 rd = cam * normalize(vec3(uv, 1.3 - 0.2 * uKick));

  float x = 0.0, d = 0.0, glow = 0.0;
  vec4 orb;
  int n = steps(48.0, 110.0), i;
  bool hit = false;
  for (i = 0; i < 130; i++) {
    if (i >= n) break;
    d = tunnel(ro + rd * x, orb);
    glow += exp(-d * 80.0);
    if (d < 0.0004 * (1.0 + x)) { hit = true; break; }
    x += d;
    if (x > 9.0) break;
  }
  vec3 p = ro + rd * x;
  vec3 col = vec3(0.0);
  if (hit) {
    vec2 e = vec2(0.0006, 0.0);
    vec3 nor = normalize(vec3(tunnelD(p + e.xyy) - tunnelD(p - e.xyy), tunnelD(p + e.yxy) - tunnelD(p - e.yxy), tunnelD(p + e.yyx) - tunnelD(p - e.yyx)));
    float dif = clamp(dot(nor, -rd), 0.0, 1.0);
    float ao = 1.0 - float(i) / float(n);
    vec3 base = pal(orb.w * 0.4 + p.z * 0.04 + uVar.z);
    col = base * (0.15 + 0.9 * dif) * ao;
    // Rings of light travelling down the tunnel, one per beat.
    float ring = exp(-abs(fract(p.z * 0.5 - uBeats * 0.5) - 0.5) * 18.0);
    col += pal(orb.x + uBeats * 0.1) * ring * (0.3 * uMusic + 1.6 * uKick) * clamp(orb.y * 2.0, 0.0, 1.0);
  }
  col += pal(0.3 + uTime * 0.02 + uVar.w) * glow * (0.01 + 0.025 * uKick + 0.015 * uPerc);
  return col * exp(-x * (0.28 - 0.1 * uEnergy));
}
`;

// Laser beams through haze, analytic: each beam is a line, and a pixel glows
// by how close its view ray passes to it. Not a scene of their own: a layer
// that POST lays behind (and a little through) whatever scene plays. Three
// rigs (uVar.x, moving on every fourth bar): a fan from the back, two
// crossing banks, and a cone that wraps around the camera.
const LASERS = `
const int BEAMS = 14;

// x: glow of the beam; y: the view-ray distance at its closest point.
vec2 beam(vec3 ro, vec3 rd, vec3 e, vec3 b, float maxT) {
  vec3 w = ro - e;
  float bb = dot(rd, b), d = dot(rd, w), f = dot(b, w);
  float den = max(1.0 - bb * bb, 1e-4);
  float tc = (bb * f - d) / den;
  float sc = max((f - bb * d) / den, 0.0);
  if (tc < 0.0 || tc > maxT) return vec2(0.0);
  vec3 pc = ro + rd * tc;
  float dist = length(pc - (e + b * sc));
  float haze = 0.45 + 0.9 * noise3(pc * 1.3 + vec3(0.0, uTime * 0.4, uTime * 0.2));
  float g = exp(-dist * dist * 1800.0) * 1.8 + exp(-dist * 9.0) * 0.16 * haze;
  return vec2(g * exp(-sc * 0.05), tc);
}

void rig(int i, float rigId, out vec3 e, out vec3 b) {
  float fi = float(i) / float(BEAMS - 1);
  float sweep = sin(uBeats * PI * 0.25 + uVar.z * TAU);
  if (rigId < 0.5) {
    // A fan from the back, opening with the energy and the build.
    float spread = 0.25 + 0.75 * max(uEnergy, uBuild);
    float ang = (fi - 0.5) * spread * 2.0 + 0.35 * sweep;
    float tilt = -0.12 + 0.18 * sin(uBeats * PI * 0.5 + fi * 3.0);
    e = vec3(0.0, 1.6, 12.0);
    b = normalize(vec3(sin(ang), tilt, -cos(ang)));
  } else if (rigId < 1.5) {
    // Two banks, left and right, crossing in the middle.
    float side = i < BEAMS / 2 ? -1.0 : 1.0;
    float k = mod(fi * 2.0, 1.0 + 1e-3);
    e = vec3(side * 6.0, 1.8 - k * 0.6, 9.0);
    float ang = -side * (0.45 + 0.35 * sin(uBeats * PI * 0.5 + side * 1.3 + k * 2.0));
    b = normalize(vec3(sin(ang), -0.08 - 0.12 * k, -cos(ang)));
  } else {
    // A cone from far ahead that wraps around the camera, spinning.
    float a = fi * TAU + uBeats * PI * 0.125 * (uVar.w < 0.5 ? 1.0 : -1.0);
    float open = 0.18 + 0.08 * sin(uBeats * PI * 0.25) + 0.05 * uKick;
    e = vec3(0.0, 0.2, 14.0);
    b = normalize(vec3(cos(a) * open, sin(a) * open, -1.0));
  }
}

vec3 scene(vec2 uv) {
  vec3 ro = vec3(0.25 * sin(uTime * 0.13), 0.1 + 0.1 * sin(uTime * 0.11), 0.0);
  mat3 cam = camera(ro, vec3(0.0, 0.25, 8.0), 0.04 * sin(uTime * 0.2));
  vec3 rd = cam * normalize(vec3(uv, 1.4));
  float rigId = mod(floor(uVar.x * 3.0) + floor(uBeats / 16.0), 3.0);

  vec3 col = vec3(0.0);
  bool mono = uVar.w > 0.7;
  float power = 0.7 + 0.2 * uKick + 0.3 * uEnergy;
  for (int i = 0; i < BEAMS; i++) {
    vec3 e, b;
    rig(i, rigId, e, b);
    // The hats flicker beams off, a different few on each 16th.
    float on = uPerc > 0.3 && hash21(vec2(float(i), floor(uBeats * 4.0))) < 0.25 * uPerc ? 0.2 : 1.0;
    vec3 c = mono ? pal(uVar.z) : pal(float(i) / float(BEAMS) * 0.6 + uTime * 0.03);
    col += c * beam(ro, rd, e, b, 1e5).x * power * on;
  }
  return col;
}
`;

// A mandala: the plane folded into n mirrored sectors, rings of petals
// blooming out from the centre in log scale, a flower of life turning under
// them, and rays along the folds. Everything breathes with the bass.
const MANDALA = `
float sectors() {
  return 6.0 + 2.0 * floor(uVar.x * 4.0);
}

vec2 fold(vec2 p, float n, float spin) {
  float seg = TAU / n;
  float a = atan(p.y, p.x) + spin;
  a = abs(mod(a + seg * 0.5, seg) - seg * 0.5);
  return length(p) * vec2(cos(a), sin(a));
}

vec3 scene(vec2 uv) {
  float n = sectors();
  float breathe = 1.0 + 0.12 * uBass + 0.06 * uKick;
  vec2 p = uv * 0.85 / breathe;
  float r = length(p);
  vec3 col = vec3(0.0);
  float seg = TAU / n;

  // Petal rings, each born at the centre and growing out.
  for (int k = 0; k < 6; k++) {
    float fk = float(k);
    float u = fract(fk / 6.0 + uTime * 0.035);
    float R = 0.04 * exp(u * 3.6);
    float fade = smoothstep(0.0, 0.25, u) * smoothstep(1.0, 0.75, u);
    float spin = (mod(fk, 2.0) * 2.0 - 1.0) * uTime * 0.08 + fk * 0.4;
    vec2 q = fold(p, n, spin);
    float petal = length(q - vec2(R, 0.0)) - R * sin(seg * 0.5) * (0.9 + 0.15 * sin(uTime + fk));
    float inner = length(q - vec2(R * 1.35, 0.0)) - R * 0.18;
    float w = 0.004 + 0.003 * uLead;
    vec3 c = pal(fk * 0.13 + u * 0.5 + uTime * 0.02 + uVar.z);
    col += c * fade * 1.4 * (w / (abs(petal) + w) + 0.6 * w / (abs(inner) + w));
    col += c * fade * (0.12 + 0.15 * uBass) * smoothstep(0.01, 0.0, petal);
  }

  // Flower of life: 19 circles on a hex lattice, slowly turning.
  vec2 f = p * rot(-uTime * 0.03) * (1.6 + 0.3 * uVar.y);
  float R0 = 0.33;
  float flower = 1e9;
  for (int i = -2; i <= 2; i++) {
    for (int j = -2; j <= 2; j++) {
      if (abs(i + j) > 2) continue;
      vec2 c = R0 * (float(i) * vec2(1.0, 0.0) + float(j) * vec2(0.5, 0.8660254));
      flower = min(flower, abs(length(f - c) - R0));
    }
  }
  col += pal(0.55 + uTime * 0.015 + uVar.w) * 0.0022 / (flower + 0.0022) * (0.35 + 0.65 * uPad + 0.5 * uKick) * smoothstep(1.2, 0.3, r);

  // Rays along the mirror lines, and a pulsing star at the centre.
  vec2 q = fold(p, n, uTime * 0.05);
  col += pal(0.1 + r) * 0.0016 / (abs(q.y) + 0.0016) * smoothstep(1.4, 0.1, r) * (0.3 + uPerc);
  col += pal(uBeats * 0.05) * exp(-r * (9.0 - 4.0 * uKick)) * (0.4 + 1.2 * uKick);
  // A ring per beat rolling outwards.
  col += pal(0.8 + uBeats * 0.05) * exp(-abs(r - uBeat * 1.4) * 30.0) * 0.6 * uKick;
  col += pal(0.7) * 0.03 * smoothstep(1.5, 0.0, r);
  return col;
}
`;

// An op-art tunnel: the plane taken to (angle, 1/radius), which is a
// cylinder (or a square duct, uVar.y) seen from its axis, flying in. Its wall
// carries a pattern per variant (uVar.x) in relief: spiral ribs, moiré
// ripples or domed studs, deeper with the bass. A lamp circles behind the
// eye, and the ring of light rolling down each beat grazes the relief as it
// passes.
const TUNNEL = `
// The wall's height at (angle, depth): 0 in the grooves, 1 on top.
float relief(float a, float z, float n, float mode) {
  if (mode < 1.0) return smoothstep(-0.9, 0.9, sin((a * n + z * 1.5) * TAU));
  if (mode < 2.0) return 0.5 + 0.5 * sin(z * 24.0) * sin(z * 25.3 + a * TAU * n);
  vec2 cell = fract(vec2(a * n * 2.0, z * 2.0)) - 0.5;
  float R = 0.32 + 0.08 * uKick;
  return smoothstep(0.0, 1.0, 1.0 - dot(cell, cell) / (R * R));
}

vec3 scene(vec2 uv) {
  uv *= rot(uTime * 0.12 + 0.4 * sin(uTime * 0.17));
  uv += 0.08 * vec2(sin(uTime * 0.3), cos(uTime * 0.23));
  float round_ = length(uv);
  float square = max(abs(uv.x), abs(uv.y));
  bool squared = uVar.y >= 0.6;
  float r = max(squared ? square : round_, 1e-3);
  float a = atan(uv.y, uv.x) / TAU + 0.5;
  float z = 0.4 / r + uTime * (0.8 + 0.8 * uEnergy);
  a += z * 0.04 * sin(uTime * 0.21) + 0.02 * uBass;
  float n = 4.0 + 4.0 * floor(uVar.z * 3.0);
  float mode = floor(uVar.x * 3.0);
  float v;
  if (mode < 1.0) {
    float s = sin((a * n + z * 1.5) * TAU);
    v = smoothstep(-fwidth(s) - 0.2, fwidth(s) + 0.2, s);
  } else if (mode < 2.0) {
    v = 0.5 + 0.5 * sin(z * 24.0) * sin(z * 25.3 + a * TAU * n);
  } else {
    vec2 cell = fract(vec2(a * n * 2.0, z * 2.0)) - 0.5;
    float d = length(cell);
    v = smoothstep(0.32 + 0.08 * uKick, 0.28, d);
  }

  // The wall point and its frame: outward normal, around, and down the tube.
  vec3 P = vec3(uv, 0.4) / r;
  vec2 out_ = squared ? (abs(uv.x) > abs(uv.y) ? vec2(sign(uv.x), 0.0) : vec2(0.0, sign(uv.y))) : uv / max(round_, 1e-3);
  vec3 N = vec3(-out_, 0.0);
  vec3 Ta = vec3(-out_.y, out_.x, 0.0);
  // The relief's slope, flattened where a pixel spans many cells.
  float h = relief(a, z, n, mode);
  float ea = 0.004 / n, ez = 0.004;
  vec2 grad = vec2((relief(a + ea, z, n, mode) - h) / ea / TAU, (relief(a, z + ez, n, mode) - h) / ez);
  float freq = mode < 1.0 ? 1.5 : mode < 2.0 ? 25.0 : 2.0;
  float depth = (mode < 1.0 ? 0.07 : mode < 2.0 ? 0.025 : 0.05) * (1.0 + 0.8 * uBass);
  depth /= 1.0 + 8.0 * freq * fwidth(z);
  vec3 nor = normalize(N - depth * (grad.x * Ta + vec3(0.0, 0.0, grad.y)));
  vec3 V = -normalize(P);

  // Colour around the tube, mirrored so it meets itself where atan wraps.
  float hue = abs(fract(a) * 2.0 - 1.0);
  vec3 ink = pal(z * 0.04 + hue + uTime * 0.02 + uVar.w);
  vec3 base = mix(pal(z * 0.04 + hue * 0.5 + uVar.w) * 0.12, ink, v);
  float ao = mix(0.4, 1.0, h);

  vec3 lamp = vec3(0.5 * cos(uTime * 0.6 + uVar.w * TAU), 0.5 * sin(uTime * 0.6 + uVar.w * TAU), -0.25);
  vec3 L = lamp - P;
  float dl = length(L);
  L /= dl;
  float fall = 1.6 / (1.0 + 0.25 * dl * dl);
  float dif = max(dot(nor, L), 0.0) * fall;
  float spec = pow(max(dot(nor, normalize(L + V)), 0.0), 40.0) * fall;

  // The nearest beat ring, on the axis at its depth.
  float u = z * 0.25 - uBeats;
  float dz = (floor(u) + 0.5 - u) * 4.0;
  vec3 R = normalize(vec3(-P.xy, dz));
  float ringPow = (0.4 * uMusic + 1.6 * uKick) * exp(-abs(dz) * 1.2);
  float ringDif = max(dot(nor, R), 0.0) * ringPow;
  float ringSpec = pow(max(dot(nor, normalize(R + V)), 0.0), 24.0) * ringPow;
  vec3 ringCol = pal(uBeats * 0.1 + 0.5);

  vec3 col = base * (0.2 + 1.3 * dif) * ao + base * ringCol * ringDif * 1.5 * ao;
  col += mix(vec3(1.0), ink, 0.4) * spec * (0.5 + 0.6 * uLead + 0.5 * uKick);
  col += ringCol * ringSpec * 0.8;
  float ring = exp(-abs(fract(u) - 0.5) * 20.0);
  col += ringCol * ring * (0.4 * uMusic + 1.6 * uKick) * 0.6;
  col *= smoothstep(0.0, 0.35, r);
  col += pal(0.1 + uTime * 0.03) * exp(-r * 10.0) * (0.6 + 1.5 * uKick);
  return col;
}
`;

const SCENE_MAIN = `
void main() {
  outColor = vec4(tone(scene(screen())), 1.0);
}
`;

export const SCENES = { bulb: BULB, kifs: KIFS, mandala: MANDALA, tunnel: TUNNEL };

/** The fragment source of scene `id`. */
export const sceneSource = (id) => COMMON + SCENES[id] + SCENE_MAIN;

/** The laser layer's fragment source: drawn like a scene, on black. */
export const laserSource = () => COMMON + LASERS + SCENE_MAIN;

export const POST = `${COMMON}
uniform sampler2D uScene, uPrev, uFeed, uLaser, uBloom;
uniform float uMix, uStrobe, uLaserMix, uTrails, uInvert, uHaze;

vec3 sceneAt(sampler2D s, vec2 uv, float split) {
  vec2 dir = (uv - 0.5) * split;
  return vec3(texture(s, uv + dir).r, texture(s, uv).g, texture(s, uv - dir).b);
}

// A lens: a touch of barrel distortion, scaled so the corners stay on screen.
vec2 lens(vec2 uv) {
  vec2 d = uv - 0.5;
  return 0.5 + d * (1.0 + 0.06 * dot(d, d)) / 1.03;
}

float fbm(vec3 p) {
  return 0.55 * noise3(p) + 0.3 * noise3(p * 2.1 + 7.3) + 0.15 * noise3(p * 4.3 + 1.7);
}

void main() {
  vec2 uv = lens(vUv);
  vec2 d = vUv - 0.5;
  // Colour fringes: always a little towards the edges, more on the kick.
  float split = 0.004 * uKick + 0.01 * uGlitch + 0.006 * uDrop + 0.012 * dot(d, d);
  vec3 col = sceneAt(uScene, uv, split);
  if (uMix < 1.0) {
    // The scene going out zooms away while the new one comes in.
    vec2 zuv = 0.5 + (uv - 0.5) / (1.0 + uMix * 0.4);
    col = mix(sceneAt(uPrev, zuv, split), col, smoothstep(0.0, 1.0, uMix));
  }
  // Trails: the last frame, a little zoomed and turned, where it is brighter.
  vec2 fuv = 0.5 + (vUv - 0.5) * rot(0.004 * sin(uTime * 0.3)) * (0.985 - 0.01 * uKick);
  col = max(col, texture(uFeed, fuv).rgb * uTrails);
  // The lasers: a faint layer behind the scene, only where it is dark.
  float lit = smoothstep(0.03, 0.4, dot(col, vec3(0.299, 0.587, 0.114)));
  col += texture(uLaser, uv).rgb * uLaserMix * mix(1.0, 0.1, lit);

  // Bloom: light bleeding past the bright parts.
  vec3 bloom = texture(uBloom, uv).rgb;
  col += bloom * (0.3 + 0.25 * uKick) * (1.0 - 0.6 * smoothstep(0.5, 1.0, dot(col, vec3(0.333))));
  // Haze: slow smoke drifting across the screen, lit by the scene's own glow.
  vec2 p = screen();
  float smoke = fbm(vec3(p * 1.1 + vec2(uTime * 0.03, -uTime * 0.02), uTime * 0.04));
  float density = uHaze * smoothstep(0.25, 0.85, smoke);
  vec3 glow = bloom * 1.1 + pal(0.6 + uTime * 0.01) * 0.03;
  col = col * (1.0 - 0.2 * density) + glow * density;

  // Film grade: a soft S, blacks lifted a hair, a little less saturation.
  col = clamp(col, 0.0, 1.0);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.9);
  col = col * 0.97 + vec3(0.012, 0.01, 0.02);

  col = mix(col, vec3(1.0) - col, uInvert);
  col = mix(col, mix(vec3(1.0), pal(uBeats * 0.25) + 0.5, 0.25), uStrobe);
  col *= 1.0 - 0.45 * dot(d, d);
  outColor = vec4(col, 1.0);
}
`;

// The bloom's first step: the bright parts of the scene, at a quarter of its
// size (four bilinear taps cover a 4×4 block).
export const BLOOM = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;

vec3 bright(vec3 c) {
  return c * smoothstep(0.45, 1.0, max(c.r, max(c.g, c.b)));
}

void main() {
  vec3 c = bright(texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  c += bright(texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  c += bright(texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb);
  c += bright(texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  outColor = vec4(c * 0.25, 1.0);
}`;

// One direction of a 9-tap Gaussian, in five bilinear fetches.
export const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;

void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.2270270;
  c += texture(uTex, vUv + uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUv - uDir * 1.3846154).rgb * 0.3162162;
  c += texture(uTex, vUv + uDir * 3.2307692).rgb * 0.0702703;
  c += texture(uTex, vUv - uDir * 3.2307692).rgb * 0.0702703;
  outColor = vec4(c, 1.0);
}`;

// Onto the canvas: FXAA (its luma-edge form) over the upscaled frame, then a
// fine film grain at screen resolution, after the smoothing so it stays sharp.
export const FINAL = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel, uRes;
uniform float uTime, uGrain;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 m = texture(uTex, vUv).rgb;
  float nw = luma(texture(uTex, vUv + vec2(-1.0, -1.0) * uTexel).rgb);
  float ne = luma(texture(uTex, vUv + vec2(1.0, -1.0) * uTexel).rgb);
  float sw = luma(texture(uTex, vUv + vec2(-1.0, 1.0) * uTexel).rgb);
  float se = luma(texture(uTex, vUv + vec2(1.0, 1.0) * uTexel).rgb);
  float lm = luma(m);
  float lo = min(lm, min(min(nw, ne), min(sw, se)));
  float hi = max(lm, max(max(nw, ne), max(sw, se)));
  vec2 dir = vec2(-((nw + ne) - (sw + se)), (nw + sw) - (ne + se));
  float reduce = max((nw + ne + sw + se) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;
  vec3 a = 0.5 * (texture(uTex, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uTex, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uTex, vUv - dir * 0.5).rgb + texture(uTex, vUv + dir * 0.5).rgb);
  float lb = luma(b);
  vec3 col = lb < lo || lb > hi ? a : b;
  // Grain, stronger in the mids the way film's is.
  float g = hash(vUv * uRes + fract(uTime * 13.7) * 91.0) - 0.5;
  col += g * uGrain * (0.4 + 0.6 * (1.0 - abs(luma(col) * 2.0 - 1.0)));
  outColor = vec4(col, 1.0);
}`;
