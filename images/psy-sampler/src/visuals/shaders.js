// GLSL (WebGL2) for the show. Every scene is a full-screen fragment shader:
// the 3D ones raymarch a distance field, the 2D ones fold the plane. They all
// share COMMON's uniforms, which renderer.js sets from a stage frame:
//
//   uTime     seconds, running faster the busier the mix
//   uBeats    beats since ▶ (uBeat, uBar: phase in the beat and the bar)
//   uKick ... each layer's envelope: 1 on its hit, decaying (stage.js DECAY)
//   uEnergy   how busy the mix is, uBuild the sweep into a drop, uDrop 1 on
//             the drop fading over a bar
//   uLow      the levels heard, low/mid/high
//   uVar      four numbers the director draws per scene: its variant
//   uPalette  0..PALETTES-1, uQuality 0..1 (raymarch steps, from the frame rate)
//
// POST mixes the scene with the previous one (a crossfade), its own last
// frame (trails), the drop's laser fans and the strobe.

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
uniform float uEnergy, uBuild, uDrop, uQuality;
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
    col += pal(orb.x + uBeats * 0.1) * ring * (0.3 + 1.6 * uKick) * clamp(orb.y * 2.0, 0.0, 1.0);
  }
  col += pal(0.3 + uTime * 0.02 + uVar.w) * glow * (0.01 + 0.025 * uKick + 0.015 * uPerc);
  return col * exp(-x * (0.28 - 0.1 * uEnergy));
}
`;

// Laser beams through haze, analytic: each beam is a line, and a pixel glows
// by how close its view ray passes to it. Three rigs (uVar.x, moving on every
// fourth bar): a fan from the back, two crossing banks, and a cone that wraps
// around the camera. Their spots land on the floor.
const LASERS = `
const int BEAMS = 14;
const float FLOOR = -1.4;

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
  float tFloor = rd.y < 0.0 ? (FLOOR - ro.y) / rd.y : 1e5;
  vec3 hitFloor = ro + rd * tFloor;

  // Haze lit from above, thicker where the beams are.
  vec3 col = pal(0.6 + uTime * 0.01) * 0.03 * (0.5 + noise3(rd * 3.0 + vec3(0.0, 0.0, uTime * 0.1)));
  bool mono = uVar.w > 0.7;
  float power = 0.55 + 0.6 * uKick + 0.35 * uEnergy + 0.3 * uLead;
  for (int i = 0; i < BEAMS; i++) {
    vec3 e, b;
    rig(i, rigId, e, b);
    // The hats flicker beams off, a different few on each 16th.
    float on = uPerc > 0.3 && hash21(vec2(float(i), floor(uBeats * 4.0))) < 0.25 * uPerc ? 0.2 : 1.0;
    vec3 c = mono ? pal(uVar.z) : pal(float(i) / float(BEAMS) * 0.6 + uTime * 0.03);
    col += c * beam(ro, rd, e, b, tFloor).x * power * on;
    // Where the beam lands on the floor.
    if (b.y < 0.0 && tFloor < 1e4) {
      vec3 spot = e + b * ((FLOOR - e.y) / b.y);
      float s = length(hitFloor.xz - spot.xz);
      col += c * exp(-s * s * 40.0) * 0.5 * power * on * exp(-tFloor * 0.05);
    }
  }
  if (tFloor < 1e4) {
    // A dark glossy floor with a faint grid.
    vec2 g = abs(fract(hitFloor.xz * 0.5) - 0.5);
    float line = exp(-min(g.x, g.y) * 60.0);
    col += pal(0.5 + hitFloor.z * 0.02) * line * 0.05 * exp(-tFloor * 0.1) * (1.0 + 2.0 * uKick);
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

// An op-art tunnel: the plane taken to (angle, 1/radius), flying in, with a
// pattern per variant (uVar.x): checkers, spiral stripes, moiré rings or
// dots, round or square (uVar.y). A ring of light rolls down it each beat.
const TUNNEL = `
vec3 scene(vec2 uv) {
  uv *= rot(uTime * 0.12 + 0.4 * sin(uTime * 0.17));
  uv += 0.08 * vec2(sin(uTime * 0.3), cos(uTime * 0.23));
  float round_ = length(uv);
  float square = max(abs(uv.x), abs(uv.y));
  float r = mix(round_, square, step(0.6, uVar.y));
  r = max(r, 1e-3);
  float a = atan(uv.y, uv.x) / TAU + 0.5;
  float z = 0.4 / r + uTime * (0.8 + 0.8 * uEnergy);
  a += z * 0.04 * sin(uTime * 0.21) + 0.02 * uBass;
  float n = 4.0 + 4.0 * floor(uVar.z * 3.0);
  float mode = floor(uVar.x * 4.0);
  float v;
  if (mode < 1.0) {
    float s = sin(z * PI * 2.0) * sin(a * n * TAU);
    v = smoothstep(-fwidth(s), fwidth(s), s);
  } else if (mode < 2.0) {
    float s = sin((a * n + z * 1.5) * TAU);
    v = smoothstep(-fwidth(s) - 0.2, fwidth(s) + 0.2, s);
  } else if (mode < 3.0) {
    v = 0.5 + 0.5 * sin(z * 24.0) * sin(z * 25.3 + a * TAU * n);
  } else {
    vec2 cell = fract(vec2(a * n * 2.0, z * 2.0)) - 0.5;
    float d = length(cell);
    v = smoothstep(0.32 + 0.08 * uKick, 0.28, d);
  }
  vec3 col = mix(pal(z * 0.04 + a * 0.5 + uVar.w) * 0.06, pal(z * 0.04 + a + uTime * 0.02 + uVar.w), v);
  float ring = exp(-abs(fract(z * 0.25 - uBeats) - 0.5) * 20.0);
  col += pal(uBeats * 0.1 + 0.5) * ring * (0.4 + 1.6 * uKick);
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

export const SCENES = { bulb: BULB, kifs: KIFS, lasers: LASERS, mandala: MANDALA, tunnel: TUNNEL };

/** The fragment source of scene `id`. */
export const sceneSource = (id) => COMMON + SCENES[id] + SCENE_MAIN;

export const POST = `${COMMON}
uniform sampler2D uScene, uPrev, uFeed;
uniform float uMix, uStrobe, uLasers, uTrails, uInvert;

vec3 sceneAt(sampler2D s, vec2 uv, float split) {
  vec2 dir = (uv - 0.5) * split;
  return vec3(texture(s, uv + dir).r, texture(s, uv).g, texture(s, uv - dir).b);
}

// The drop's fans: beams from below the screen, opening with uLasers.
vec3 fans(vec2 p) {
  vec3 col = vec3(0.0);
  vec2 o = vec2(0.0, -1.25);
  float spread = 0.25 + 0.9 * uLasers;
  for (int i = 0; i < 9; i++) {
    float fi = float(i) / 8.0;
    float ang = (fi - 0.5) * spread * 2.0 + 0.3 * sin(uBeats * PI * 0.5 + fi * 2.0);
    vec2 dir = vec2(sin(ang), cos(ang));
    vec2 rel = p - o;
    float along = dot(rel, dir);
    if (along < 0.0) continue;
    float d = abs(rel.x * dir.y - rel.y * dir.x);
    col += pal(fi * 0.5 + uBeats * 0.05) * (exp(-d * d * 30000.0) + 0.15 * exp(-d * 60.0)) * smoothstep(3.0, 0.5, along);
  }
  return col;
}

void main() {
  vec2 uv = vUv;
  float split = 0.004 * uKick + 0.01 * uGlitch + 0.006 * uDrop;
  vec3 col = sceneAt(uScene, uv, split);
  if (uMix < 1.0) {
    // The scene going out zooms away while the new one comes in.
    vec2 zuv = 0.5 + (uv - 0.5) / (1.0 + uMix * 0.4);
    col = mix(sceneAt(uPrev, zuv, split), col, smoothstep(0.0, 1.0, uMix));
  }
  // Trails: the last frame, a little zoomed and turned, where it is brighter.
  vec2 fuv = 0.5 + (uv - 0.5) * rot(0.004 * sin(uTime * 0.3)) * (0.985 - 0.01 * uKick);
  col = max(col, texture(uFeed, fuv).rgb * uTrails);
  col += fans(screen()) * uLasers * (0.6 + 0.8 * uKick);
  // Glitch: slices of the frame shoved sideways on glitch hits.
  if (uGlitch > 0.2) {
    float band = floor(uv.y * 24.0 + floor(uBeats * 8.0) * 7.0);
    if (hash21(vec2(band, floor(uBeats * 8.0))) < uGlitch * 0.35) {
      col = sceneAt(uScene, vec2(fract(uv.x + (hash21(vec2(band, 3.0)) - 0.5) * 0.2), uv.y), 0.02);
    }
  }
  col = mix(col, vec3(1.0) - col, uInvert);
  col = mix(col, mix(vec3(1.0), pal(uBeats * 0.25) + 0.5, 0.25), uStrobe);
  vec2 v = uv - 0.5;
  col *= 1.0 - 0.45 * dot(v, v);
  col += (hash21(uv * uRes + fract(uTime)) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;

export const COPY = `#version 300 es
precision mediump float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
void main() {
  outColor = texture(uTex, vUv);
}`;
