// GLSL (WebGL2) for the show. Every scene is a full-screen fragment shader:
// the 3D ones raymarch a distance field, the 2D ones fold the plane. They all
// share COMMON's uniforms, which renderer.js sets from a stage frame:
//
//   uTime     seconds, running faster the busier the mix
//   uBeats    beats since ▶ (uBeat, uBar: phase in the beat and the bar)
//   uKick ... each layer's envelope: 1 on its hit, decaying (stage.js DECAY):
//             for light only. Added to a position it snaps out on the hit
//             and slides back, so whatever moves rides uPush instead
//   uPush     how far the beat has thrown the picture: it only goes forward,
//             fast on a kick and braking by friction after (motion.js);
//             uSurge its speed, eased, for what swells with it
//   uShake    the camera's tremor near a drop: x, y (short side) and a turn,
//             applied by POST
//   uEnergy   how busy the mix is, uBuild the sweep into a drop, uDrop 1 on
//             the drop fading over a bar
//   uLow      the levels heard, low/mid/high; uMusic 1 while something
//             plays, fading to 0 at rest, where nothing may pulse on the beat
//   uVar      four numbers the director draws per scene: its variant
//   uPalette  0..PALETTES-1, uQuality 0..1 (raymarch steps, from the frame rate)
//
// POST mixes the scene with the previous one (a crossfade), its own last
// frame (trails), the bloom (BLOOM + BLUR) and a haze lit by it, through a
// lens and a film grade, then the strobe. FINAL puts it on the canvas with
// FXAA and grain.

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
uniform float uEnergy, uBuild, uDrop, uQuality, uMusic, uPush, uSurge;
uniform vec3 uLow, uShake;
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

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
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

// A Mandelbulb seen from an orbit that the beat swings along; each step
// tilts as it goes, so it slowly morphs. Colour from an orbit trap. The power
// is whole and the tilt a rotation: a fractional power, or an offset added
// to th, tears the set along a seam (atan's cut, the z axis).
const BULB = `
float bulb(vec3 p, out float trap) {
  vec3 z = p;
  float dr = 1.0, r = 0.0;
  float power = floor(6.0 + 4.99 * uVar.x);
  float tilt = (0.3 + 0.4 * uVar.y) * sin((uTime + 0.6 * uPush) * 0.07 + uVar.y * TAU);
  mat2 tr = rot(tilt);
  trap = 1e9;
  for (int i = 0; i < 6; i++) {
    r = length(z);
    if (r > 2.0) break;
    float th = acos(clamp(z.z / r, -1.0, 1.0)) * power;
    float ph = atan(z.y, z.x) * power + uTime * 0.05;
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    z = pow(r, power) * vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));
    z.yz = tr * z.yz;
    z += p;
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
  float t = (uTime + 0.6 * uPush) * 0.18 + uVar.z * TAU;
  float dist = 2.25 - 0.35 * uEnergy + 0.3 * sin(uTime * 0.05);
  vec3 ro = dist * vec3(sin(t), 0.45 * sin(t * 0.6 + uVar.y * TAU), cos(t));
  mat3 cam = camera(ro, vec3(0.0), 0.2 * sin(uTime * 0.1));
  vec3 rd = cam * normalize(vec3(uv, 1.7));

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
// Each beat flies the camera on, further the deeper it is.
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
    p.yz *= rot(0.5 + 0.2 * uVar.z);
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
  float bore = 0.22 - length(p.xy - path(p.z));
  return max(d, bore);
}

float tunnelD(vec3 p) {
  vec4 o;
  return tunnel(p, o);
}

vec3 scene(vec2 uv) {
  float z = uTime * (0.45 + 0.35 * uEnergy) + 0.7 * uPush;
  vec3 ro = vec3(path(z), z);
  vec3 ta = vec3(path(z + 1.0), z + 1.0);
  mat3 cam = camera(ro, ta, uTime * 0.12 + 0.6 * sin(uTime * 0.07));
  vec3 rd = cam * normalize(vec3(uv, 1.3 - 0.12 * uSurge));

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

// A mandala that is a flower: rings of n petals (pointed, round or fanned,
// uVar.y), each laid over and shading the one behind it, opening out from
// under a seed head of Fibonacci spirals in log scale, so the bloom never
// ends, faster on each beat. Rays along the folds behind.
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

// A petal's half width at t (0 at its base, 1 at its tip), 0..1 of its
// sector: pointed (a lotus), round (a daisy) or a fan (a cosmos).
float petalWidth(float t, float style) {
  t = clamp(t, 0.0, 1.0);
  if (style < 1.0) return pow(sin(PI * pow(t, 0.8)), 0.9);
  if (style < 2.0) return 2.0 * sqrt(t * (1.0 - t));
  return pow(t, 0.45) * sqrt(1.0 - pow(t, 6.0));
}

vec3 scene(vec2 uv) {
  float n = sectors();
  float style = floor(uVar.y * 3.0);
  float breathe = 1.0 + 0.04 * uSurge;
  vec2 p = uv * 0.9 / breathe * rot(uTime * 0.02);
  float r = max(length(p), 1e-4);
  float ang = atan(p.y, p.x) / TAU;
  float px = fwidth(r) * 1.5;

  vec3 col = pal(0.7 + uVar.w) * 0.05 * smoothstep(1.6, 0.0, r);
  // Rays along the folds, behind the petals.
  vec2 q = fold(p, n, uTime * 0.05);
  col += pal(0.1 + r) * 0.0012 / (abs(q.y) + 0.0012) * smoothstep(1.5, 0.3, r) * (0.2 + 0.8 * uPerc);

  // Rings of petals in log scale, born under the seed head and opening out:
  // drawn from the outside in, each over (and shading) the ones behind it.
  const int K = 7;
  float stepK = 0.42;
  float grow = (uTime + uPush) * 0.05;
  float g0 = fract(grow);
  float m = style == 1.0 ? 2.0 * n : n;
  float open = 0.86 + 0.06 * uSurge;
  for (int j = K - 1; j >= 0; j--) {
    float g = float(j) + g0;
    float id = float(j) - floor(grow);
    float R = 0.13 * exp(g * stepK);
    float base = R * 0.3;
    float fade = smoothstep(0.0, 0.6, g) * smoothstep(float(K), float(K) - 1.8, g);
    float spin = 0.15 * sin(id * 1.7 + uTime * 0.1);
    float a = fract(ang * m + 0.5 * mod(id, 2.0) + spin);
    float c = (a - 0.5) * 2.0;
    float tipR = style == 2.0 ? R * (1.0 - 0.07 * exp(-c * c * 30.0)) * (1.0 - 0.04 * abs(sin(c * PI * 1.5))) : R;
    float t = (r - base) / (tipR - base);
    float half_ = petalWidth(t, style) * open;
    float d = max((abs(c) - half_) * r * PI / m, r - tipR);
    float cover = smoothstep(px, -px, d) * fade;
    float shadow = smoothstep(0.06 * R, -0.01 * R, d) * fade;
    col *= 1.0 - 0.6 * shadow;

    float x = clamp(abs(c) / max(half_, 1e-3), 0.0, 1.0);
    float h = id * 0.11 + uVar.z + uTime * 0.01;
    vec3 tint = mix(pal(h) * 0.25, pal(h + 0.08), smoothstep(-0.1, 0.9, t));
    tint = mix(tint, pal(h + 0.3) * 1.3, smoothstep(0.55, 1.0, t) * 0.35);
    float cup = 0.5 + 0.5 * sqrt(1.0 - x * x);
    float veins = 0.88 + 0.12 * cos(x * PI * 7.0);
    float rib = mix(0.75, 1.0, smoothstep(0.0, 0.12, x));
    vec3 petal = tint * cup * veins * rib * (0.9 + 0.4 * uPad);
    float rim = smoothstep(4.0 * px, 0.0, -d) * cover;
    petal += pal(h + 0.5) * rim * (0.5 + 0.9 * uLead);
    col = mix(col, petal, cover);
  }

  // The seed head: florets on Fibonacci spirals (13 one way, 21 the
  // other), turning slowly, swelling with the beat.
  float Rc = 0.17 * (1.0 + 0.04 * uSurge);
  col *= 1.0 - 0.55 * smoothstep(Rc * 1.4, Rc, r);
  float l = log(r) - (uTime + uPush) * 0.04;
  vec2 cell = vec2(13.0 * ang + 21.0 * l / TAU, 21.0 * ang - 13.0 * l / TAU);
  vec2 f = fract(cell) - 0.5;
  // Florets per pixel, from r alone: fwidth(cell) jumps on atan's seam.
  float dense = 3.93 * fwidth(r) / r;
  float seed = mix(smoothstep(0.42, 0.42 - max(dense, 0.08), length(f)), 0.45, smoothstep(0.25, 0.6, dense));
  float lit = 0.6 + 0.4 * (0.5 - f.y) + 0.7 * smoothstep(0.18, 0.0, length(f - vec2(-0.1, 0.12)));
  vec3 head = mix(pal(0.05 + uVar.w) * 0.08, pal(0.12 + uVar.w + r * 2.0) * lit + 0.12, seed);
  head *= 0.6 + 0.6 * smoothstep(0.0, Rc, r) + 0.8 * uKick * seed;
  float disc = smoothstep(Rc + px, Rc - px, r);
  col = mix(col, head, disc);
  col += pal(0.15 + uVar.w) * smoothstep(px * 3.0, 0.0, abs(r - Rc)) * (0.4 + 0.6 * uKick);
  col += pal(uBeats * 0.05) * exp(-r * (14.0 - 6.0 * uKick)) * (0.3 + 0.9 * uKick);
  // A ring of pollen per beat rolling outwards.
  col += pal(0.8 + uBeats * 0.05) * exp(-abs(r - uBeat * 1.4) * 30.0) * 0.5 * uKick;
  return col;
}
`;

// A liquid: fbm warped by fbm warped by fbm (iq's domain warping), turning
// over itself. Each kick and bass note sends the current rushing on and
// friction brakes it, and a light grazing its folds gives it a wet relief.
// Three looks (uVar.x): marble with veins, an oil slick's thin-film colours,
// a nebula with stars.
const FLOW = `
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise2(p);
    p = rot(0.6) * p * 2.02 + 7.3;
    a *= 0.5;
  }
  return s / 0.97;
}

// The warped field at p; q and r are its two warps.
float field(vec2 p, float time, out vec2 q, out vec2 r) {
  float t = time * 0.05;
  float warp = 1.45 + 0.9 * uVar.z + 0.25 * uEnergy;
  q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.8));
  r = vec2(fbm(p + warp * q + vec2(1.7, 9.2) + t * 1.4), fbm(p + warp * q + vec2(8.3, 2.8) - t * 1.1));
  return fbm(p + warp * r);
}

vec3 scene(vec2 uv) {
  float time = uTime + 1.2 * uPush;
  vec2 p = uv * (0.7 + 0.4 * uVar.y) * rot(time * 0.015) + vec2(time * 0.02, 0.0);
  vec2 q, r, q2, r2;
  float e = 2.0 / min(uRes.x, uRes.y);
  float f = field(p, time, q, r);
  vec2 grad = vec2(field(p + vec2(e, 0.0), time, q2, r2) - f, field(p + vec2(0.0, e), time, q2, r2) - f) / e;
  vec3 nor = normalize(vec3(-grad * (0.035 + 0.02 * uSurge), 1.0));
  vec3 L = normalize(vec3(0.6 * cos(uTime * 0.2), 0.6 * sin(uTime * 0.2), 0.8));
  float dif = max(dot(nor, L), 0.0);
  float spec = pow(max(dot(nor, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
  float hue = f * 0.6 + length(q) * 0.35 + uTime * 0.01 + uVar.w;
  float mode = floor(uVar.x * 3.0);
  vec3 col;
  if (mode < 1.0) {
    // Marble: two stones folded together, veins along the field's contours.
    vec3 base = mix(pal(hue), pal(hue + 0.5) * 0.3, smoothstep(0.35, 0.75, r.x));
    float c = f * 4.0 + r.y;
    float vein = 1.0 - smoothstep(0.0, 0.04 + fwidth(c), abs(fract(c) - 0.5));
    col = base * (0.2 + 0.9 * dif) + pal(hue + 0.25) * vein * (0.35 + 0.8 * uLead + 0.6 * uKick) + spec * 0.5;
  } else if (mode < 2.0) {
    // Oil: dark water and a thin film whose colour turns with the slope.
    float film = f * 3.0 + dot(nor.xy, nor.xy) * 5.0 + uTime * 0.03;
    col = pal(film + uVar.w) * (0.12 + 0.8 * smoothstep(0.3, 0.8, f)) * (0.3 + 0.9 * dif) + spec * 0.8;
  } else {
    // Nebula: gas lit from inside, densest where the field folds over.
    float dens = pow(smoothstep(0.25, 0.95, f), 2.0);
    col = pal(hue) * dens * 1.4 + pal(hue + 0.4) * pow(length(r) * 0.6, 4.0) * 0.6;
    vec2 sg = uv * 70.0 + vec2(uTime * 0.5, 0.0);
    float star = step(0.992, hash21(floor(sg))) * exp(-length(fract(sg) - 0.5) * 9.0);
    col += vec3(star) * (0.5 + 0.8 * uPerc);
  }
  // The kick's ring rolling out through the liquid.
  return col * (1.0 + 0.5 * uKick * exp(-abs(length(uv) - fract(uBeat) * 1.6) * 5.0));
}
`;

// A Julia set whose c walks the rim of the Mandelbrot set's main cardioid
// (or of the bulb left of it, uVar.y), so it is always on the edge between
// one connected shape and dust; each beat walks c on along it.
// Outside, bands of escape time, a glow on the boundary from the distance
// estimate and a band per beat rolling through them; inside, orbit traps.
const JULIA = `
vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec3 scene(vec2 uv) {
  float time = uTime + 0.5 * uPush;
  float a = time * 0.03 + uVar.x * TAU;
  vec2 e = vec2(cos(a), sin(a));
  vec2 c = uVar.y < 0.7 ? 0.5 * e - 0.25 * cmul(e, e) : vec2(-1.0, 0.0) + 0.25 * e;
  c *= 1.0 + 0.015 * sin(time * 0.11);
  float zoom = 1.5 - 0.25 * uVar.z;
  vec2 z = uv * zoom * rot(time * 0.025);
  vec2 dz = vec2(1.0, 0.0);
  vec2 tp = 0.5 * vec2(cos(uBeats * PI * 0.25), sin(uBeats * PI * 0.25));
  float trapP = 1e9, trapX = 1e9, m = 0.0;
  int n = steps(90.0, 220.0), i;
  for (i = 0; i < 220; i++) {
    if (i >= n) break;
    dz = 2.0 * cmul(z, dz);
    z = cmul(z, z) + c;
    m = dot(z, z);
    trapP = min(trapP, length(z - tp));
    trapX = min(trapX, min(abs(z.x), abs(z.y)));
    if (m > 4096.0) break;
  }
  if (m <= 4096.0) {
    float glow = exp(-trapP * 2.5);
    vec3 col = pal(0.25 * glow + uTime * 0.02 + uVar.w) * (0.05 + 0.8 * glow * glow);
    col += pal(0.5 + uVar.w) * exp(-trapX * 25.0) * (0.1 + 0.5 * uLead + 0.3 * uPad);
    return col * (0.75 + 0.5 * uKick);
  }
  float sm = float(i) - log2(log2(m)) + 4.0;
  float d = 0.25 * sqrt(m / dot(dz, dz)) * log(m);
  float px = 2.0 * zoom / min(uRes.x, uRes.y);
  vec3 col = pal(sm * 0.03 + uTime * 0.02 + uVar.w) * 0.1 * min(sm * 0.06, 1.0);
  vec3 edge = pal(sm * 0.03 + 0.2 + uVar.w);
  col += edge * (smoothstep(1.5, 0.0, d / px) * 0.9 + exp(-d * 10.0 / zoom) * (0.35 + 0.5 * uKick));
  float band = exp(-abs(fract(sm * 0.06 - uBeats * 0.25) - 0.5) * 24.0);
  col += pal(0.6 + uBeats * 0.05) * band * (0.15 * uMusic + 0.6 * uKick) * exp(-d * 3.0 / zoom);
  return col;
}
`;

// Flesh: a gyroid, the minimal surface that splits space into two
// interlocked labyrinths, thickened into a wall and flown through. A finer
// gyroid wrinkles it, the beat flies on through it and makes it throb, and
// veins of light (a third gyroid) glow with the lead. Its two faces get two
// colours.
const GYROID = `
float gyroid(vec3 p) {
  return dot(sin(p), cos(p.yzx));
}

float scale() {
  return 1.6 + 0.8 * uVar.x;
}

vec2 path(float z) {
  return vec2(0.8 * sin(z * 0.23), 0.6 * cos(z * 0.17));
}

float flesh(vec3 p) {
  float s = scale();
  float th = 0.3 + 0.25 * uVar.y + 0.1 * uSurge;
  float d = (abs(gyroid(p * s)) - th) / (s * 1.8);
  d -= 0.03 * gyroid(p * s * 3.1 + vec3(0.0, 0.0, uTime * 0.3)) + 0.02 * noise3(p * 14.0);
  float bore = 0.3 - length(p.xy - path(p.z));
  return max(d, bore) * 0.7;
}

vec3 scene(vec2 uv) {
  float z = uTime * (0.35 + 0.3 * uEnergy) + 0.45 * uPush;
  vec3 ro = vec3(path(z), z);
  mat3 cam = camera(ro, vec3(path(z + 1.0), z + 1.0), 0.3 * sin(uTime * 0.1));
  vec3 rd = cam * normalize(vec3(uv, 1.2 - 0.1 * uSurge));
  float x = 0.0, d = 0.0;
  int n = steps(40.0, 100.0), i;
  bool hit = false;
  for (i = 0; i < 110; i++) {
    if (i >= n) break;
    d = flesh(ro + rd * x);
    if (d < 0.001 * (1.0 + x)) { hit = true; break; }
    x += d;
    if (x > 8.0) break;
  }
  vec3 fog = pal(0.55 + uTime * 0.01 + uVar.w) * 0.05;
  if (!hit) return fog;
  vec3 p = ro + rd * x;
  vec2 k = vec2(1, -1) * 0.0015;
  vec3 nor = normalize(k.xyy * flesh(p + k.xyy) + k.yyx * flesh(p + k.yyx) + k.yxy * flesh(p + k.yxy) + k.xxx * flesh(p + k.xxx));
  float side = step(0.0, gyroid(p * scale()));
  vec3 base = pal(side * 0.5 + p.z * 0.02 + uVar.w);
  float ao = 1.0 - float(i) / float(n);
  vec3 L = normalize(vec3(0.4 * sin(uTime * 0.4), 0.6, 0.5));
  float dif = 0.15 + 0.5 * max(dot(nor, -rd), 0.0) + 0.5 * max(dot(nor, L), 0.0);
  float fres = pow(1.0 - max(dot(nor, -rd), 0.0), 3.0);
  float spec = pow(max(dot(reflect(rd, nor), L), 0.0), 30.0);
  float vein = exp(-abs(gyroid(p * 7.0 + vec3(0.0, 0.0, -uTime * 0.6))) * 10.0);
  vec3 col = base * dif * dif * (0.25 + 0.75 * ao * ao);
  col += pal(side * 0.5 + 0.25 + uVar.w) * fres * 0.35 + spec * 0.4;
  col += pal(0.3 + uVar.w + uTime * 0.02) * vein * (0.15 + 1.1 * uLead + 0.5 * uKick);
  float ring = exp(-abs(fract(p.z * 0.5 - uBeats * 0.5) - 0.5) * 14.0);
  col += base * ring * (0.2 * uMusic + 0.9 * uKick);
  return mix(fog, col, exp(-x * 0.45));
}
`;

// A reef: Knighty's pseudo-Kleinian fractal (box folds and sphere
// inversions, near the limit set of a Kleinian group), repeated along the
// flight and bored through. Its finest tips glow like polyps with the hats
// and the lead; the box (uVar.x, uVar.z) sets the species.
const CORAL = `
vec3 box() {
  return vec3(0.92436 + 0.06 * (uVar.x - 0.5), 0.90756, 0.92436 + 0.05 * (uVar.z - 0.5));
}

vec2 path(float z) {
  return vec2(0.25 * sin(z * 0.4), 0.2 * cos(z * 0.3));
}

float reef(vec3 p, out vec4 orb) {
  vec3 C = box();
  float bore = 0.12 - length(p.xy - path(p.z));
  p = mod(p + 2.0 * C, 4.0 * C) - 2.0 * C;
  float k = 1.0;
  orb = vec4(1e3);
  for (int i = 0; i < 8; i++) {
    p = 2.0 * clamp(p, -C, C) - p;
    float r2 = dot(p, p);
    float s = max(1.0 / r2, 1.0);
    p *= s;
    k *= s;
    orb = min(orb, vec4(abs(p), r2));
  }
  float rxy = length(p.xy);
  float d = 0.5 * max(rxy - 0.92784, abs(rxy * p.z) / length(p)) / k;
  return max(d, bore);
}

float reefD(vec3 p) {
  vec4 o;
  return reef(p, o);
}

vec3 scene(vec2 uv) {
  float z = uTime * (0.12 + 0.1 * uEnergy) + 0.12 * uPush;
  vec3 ro = vec3(path(z), z);
  mat3 cam = camera(ro, vec3(path(z + 0.5), z + 0.5), uTime * 0.05);
  vec3 rd = cam * normalize(vec3(uv, 1.1 - 0.06 * uSurge));
  float x = 0.0, d = 0.0;
  vec4 orb;
  int n = steps(50.0, 120.0), i;
  bool hit = false;
  for (i = 0; i < 130; i++) {
    if (i >= n) break;
    d = reef(ro + rd * x, orb);
    if (d < 0.0003 * (1.0 + 4.0 * x)) { hit = true; break; }
    x += d;
    if (x > 4.0) break;
  }
  vec3 fog = pal(0.6 + uVar.w) * 0.04;
  if (!hit) return fog;
  vec3 p = ro + rd * x;
  vec2 e = vec2(0.0005, 0.0);
  vec3 nor = normalize(vec3(reefD(p + e.xyy) - reefD(p - e.xyy), reefD(p + e.yxy) - reefD(p - e.yxy), reefD(p + e.yyx) - reefD(p - e.yyx)));
  float ao = pow(1.0 - float(i) / float(n), 1.5);
  vec3 base = pal(orb.w * 0.5 + orb.x * 0.3 + uVar.w + uTime * 0.01);
  vec3 L = normalize(vec3(0.5, 0.8, -0.3));
  float dif = max(dot(nor, L), 0.0) * 0.7 + 0.3 * max(dot(nor, -rd), 0.0);
  float rim = pow(1.0 - max(dot(nor, -rd), 0.0), 4.0);
  vec3 col = base * (0.1 + 0.9 * dif) * ao + pal(orb.w + 0.5 + uVar.w) * rim * 0.3 * ao;
  float polyp = exp(-orb.y * 12.0);
  col += pal(0.15 + uVar.w + uBeats * 0.02) * polyp * (0.2 + 0.8 * uPerc + 0.6 * uLead) * ao;
  col *= 1.0 + 0.4 * uKick;
  return mix(fog, col, exp(-x * 0.6));
}
`;

// Under a microscope: Voronoi cells drifting, membranes from the exact
// distance to each cell's border (iq), a nucleus off centre, grains in the
// cytoplasm and a second layer out of focus behind. A ripple from the centre
// runs through the tissue on each kick and swells the cells it passes; the
// nuclei light up with the hats. Dark field or stained (uVar.x), with or
// without the eyepiece's round field (uVar.y).
const CELLS = `
vec2 hash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

vec2 centre(vec2 n, float t) {
  return 0.5 + 0.38 * sin(t + TAU * hash22(n));
}

// x: distance to the nearest border; yz: the cell's id. mr runs from x to its centre.
vec3 cell(vec2 x, float t, out vec2 mr) {
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(i, j);
      vec2 r = g + centre(n + g, t) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(i, j);
      vec2 r = g + centre(n + g, t) - f;
      if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
    }
  }
  return vec3(md, n + mg);
}

vec3 scene(vec2 uv) {
  float scale = 3.2 + 1.5 * uVar.z;
  vec2 drift = vec2(uTime * 0.05, 0.4 * sin(uTime * 0.03));
  vec2 p = uv * rot(uTime * 0.01) * scale + drift;
  p += 0.35 * (vec2(noise2(p * 0.7 + uTime * 0.05), noise2(p * 0.7 + 5.3 - uTime * 0.05)) - 0.5);
  vec2 mr;
  vec3 c = cell(p, uTime * 0.25, mr);
  float id = hash21(c.yz);
  vec2 at = (p + mr - drift) / scale;
  float ripple = exp(-abs(length(at) - fract(uBeat) * 1.8) * 4.0) * uKick;
  float swell = 1.0 + 0.3 * ripple + 0.08 * uBass;
  vec2 off = (hash22(c.yz + 3.1) - 0.5) * 0.2;
  float rn = (0.13 + 0.05 * hash21(c.yz + 7.0)) * swell;
  float nd = length(mr + off);
  float nucleus = smoothstep(rn, rn - 0.03, nd);
  float nucleolus = smoothstep(rn * 0.35, rn * 0.15, length(mr + off + (hash22(c.yz + 9.0) - 0.5) * 0.1));
  float body = smoothstep(0.0, 0.25 * swell, c.x);
  float membrane = exp(-c.x * (45.0 - 15.0 * uBass)) + 0.5 * exp(-abs(c.x - 0.05) * 60.0);
  float grain = noise2(p * 9.0 + id * 31.0) * noise2(p * 23.0 - uTime * 0.2);
  vec2 mb;
  vec3 b = cell(uv * scale * 0.55 + drift * 0.5 + 17.0, uTime * 0.15, mb);
  float back = smoothstep(0.15, 0.0, b.x);
  vec3 tint = pal(id * 0.25 + uTime * 0.01 + uVar.w);
  vec3 col;
  if (uVar.x < 0.5) {
    // Dark field: light only where something scatters it.
    col = pal(0.6 + uVar.w) * 0.02 + pal(0.7 + uVar.w) * back * 0.1;
    col += tint * (membrane * (0.7 + 0.8 * ripple) + body * 0.05 + grain * body * 0.15);
    col += pal(id * 0.25 + 0.5 + uVar.w) * (nucleus * (0.2 + 0.7 * uPerc) + nucleolus * (0.4 + 0.8 * uPerc));
  } else {
    // Stained: a pale slide, tinted cytoplasm, dark nuclei.
    col = mix(vec3(0.55), pal(0.1 + uVar.w), 0.3) * (1.0 - 0.2 * back);
    col = mix(col, tint * 0.8 + 0.1, body * 0.4 + grain * 0.1);
    col *= 1.0 - 0.6 * min(membrane, 1.0);
    col = mix(col, pal(0.65 + uVar.w) * 0.25, nucleus * 0.85);
    col += pal(0.65 + uVar.w) * nucleolus * 0.3 * uPerc + tint * ripple * 0.3;
  }
  if (uVar.y > 0.6) col *= smoothstep(1.0, 0.94, length(uv));
  return col;
}
`;

// A romanesco, or a succulent, seen from above: buds on two families of log
// spirals (consecutive Fibonacci counts, uVar.x). That is a plain lattice in
// (log r, angle), so finding a pixel's bud is a floor(). The head grows out
// forever (log r slides) and, when uVar.y says so, every bud is itself a
// smaller head of buds: the romanesco's fractal. Lit in relief.
const PHYLLO = `
const vec2 FIBS[4] = vec2[4](vec2(8.0, 13.0), vec2(13.0, 21.0), vec2(21.0, 34.0), vec2(5.0, 8.0));

// The bud under p in a head of mn spirals: xy its local coordinates (x out
// from the centre, the bud's rim at 0.5), z its index along the spiral.
vec3 bud(vec2 p, vec2 mn, float grow, float spin) {
  float u = log(max(length(p), 1e-6)) - grow;
  float v = atan(p.y, p.x) + spin;
  vec2 st = vec2(mn.x * v + mn.y * u, mn.y * v - mn.x * u) / TAU;
  vec2 id = floor(st + 0.5);
  vec2 c = st - id;
  return vec3(vec2(mn.y * c.x - mn.x * c.y, mn.x * c.x + mn.y * c.y) / length(mn), id.x * mn.y - id.y * mn.x);
}

float dome(vec2 q) {
  q.x -= 0.04;
  q.y *= 1.0 + 2.0 * uVar.z * max(q.x + 0.1, 0.0);
  return max(0.0, 1.0 - dot(q, q) * 4.2 / (1.0 + 0.25 * uKick));
}

vec2 heads() {
  return FIBS[int(uVar.x * 4.0)];
}

// The head's height at p; k is the bud's index.
float height(vec2 p, float size, out float k) {
  vec2 mn = heads();
  vec3 b = bud(p, mn, uTime * 0.08, uTime * 0.03);
  k = b.z;
  float h = dome(b.xy);
  if (uVar.y > 0.4) {
    vec3 s = bud(b.xy / 0.42, mn, uTime * 0.14 + b.z * 0.37, -uTime * 0.06);
    h *= 0.72 + 0.28 * dome(s.xy) * smoothstep(0.03, 0.1, size);
  }
  return h;
}

vec3 scene(vec2 uv) {
  vec2 p = uv * (1.0 + 0.08 * sin(uTime * 0.1));
  float r = length(p);
  float size = r * TAU / length(heads());
  float e = 1.0 / min(uRes.x, uRes.y);
  float k, k2;
  float h = height(p, size, k);
  vec2 g = vec2(height(p + vec2(e, 0.0), size, k2) - h, height(p + vec2(0.0, e), size, k2) - h) / e;
  float sharp = smoothstep(3.0 * e, 10.0 * e, size);
  vec3 nor = normalize(vec3(-g * size * (0.18 + 0.12 * uBass) * sharp, 1.0));
  vec3 L = normalize(vec3(0.5 * cos(uTime * 0.3), 0.5 * sin(uTime * 0.3), 0.7));
  float dif = max(dot(nor, L), 0.0);
  float spec = pow(max(dot(nor, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 24.0);
  vec3 base = pal(log(r + 1e-3) * 0.15 + hash21(vec2(k, 0.37)) * 0.12 + uTime * 0.01 + uVar.w);
  float wave = exp(-abs(fract(log(r + 1e-3) * 0.6 - uBeats * 0.5) - 0.5) * 10.0);
  vec3 col = base * (0.1 + 0.95 * dif) * (0.3 + 0.7 * h) + spec * 0.45 * h;
  col += base * wave * h * (0.15 * uMusic + 1.0 * uKick);
  col *= smoothstep(2.0 * e, 6.0 * e, size);
  col += pal(uBeats * 0.05 + uVar.w) * exp(-r * 14.0) * (0.4 + uKick);
  return col;
}
`;

// A hyperbolic tiling {p,q} (uVar.x, q even so the tiles can alternate two
// colours) in the Poincaré disc: each point is folded into one triangle by
// reflecting it across the polygon's mirrors and inverting it in the circle
// of its edge until it lands. A Möbius translation drifts the disc, so the
// tiles flow out to the rim (faster on each beat), where they shrink without
// end. Petals inside each tile, and a ring of tiles lighting up per beat,
// counted outwards.
const HYPER = `
const vec2 PQ[4] = vec2[4](vec2(5.0, 4.0), vec2(6.0, 4.0), vec2(4.0, 6.0), vec2(3.0, 8.0));

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

vec2 cdiv(vec2 a, vec2 b) {
  return vec2(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / dot(b, b);
}

vec3 scene(vec2 uv) {
  vec2 pq = PQ[int(uVar.x * 4.0)];
  float seg = PI / pq.x;
  float sp = sin(seg), cq = cos(PI / pq.y);
  float cx = 1.0 / sqrt(1.0 - sp * sp / (cq * cq));
  float cr = cx * sp / cq;
  vec2 C = vec2(cx, 0.0);
  vec2 z = uv;
  float rr = length(z);
  vec3 halo = pal(0.6 + uTime * 0.02 + uVar.w) * exp(-abs(rr - 1.0) * 12.0) * (0.15 + 0.4 * uKick);
  if (rr >= 1.0) return halo;
  float time = uTime + 0.8 * uPush;
  vec2 a = 0.6 * vec2(cos(time * 0.07 + uVar.z * TAU), sin(time * 0.05 + uVar.y * TAU));
  z = cdiv(z - a, vec2(1.0, 0.0) - cmul(vec2(a.x, -a.y), z));
  z *= rot(time * 0.04);
  float depth = 0.0;
  for (int i = 0; i < 48; i++) {
    float m = mod(atan(z.y, z.x), 2.0 * seg);
    if (m > seg) m = 2.0 * seg - m;
    z = length(z) * vec2(cos(m), sin(m));
    vec2 d = z - C;
    float dd = dot(d, d);
    if (dd >= cr * cr) break;
    z = C + d * (cr * cr / dd);
    depth += 1.0;
  }
  float edge = length(z - C) - cr;
  float t = length(z) / (cx - cr);
  float ang = atan(z.y, z.x) / seg;
  float par = mod(depth, 2.0);
  float bound = 0.3 + 0.55 * pow(cos(ang * PI * 0.5), 3.0) * (1.0 + 0.08 * uSurge);
  float fw = fwidth(t) + 1e-4;
  float petal = smoothstep(fw, -fw, t - bound);
  vec3 tile = pal(par * 0.5 + depth * 0.04 + uTime * 0.02 + uVar.w);
  vec3 col = tile * (0.12 + 0.2 * (1.0 - t));
  col = mix(col, pal(par * 0.5 + 0.25 + uVar.w) * (0.4 + 0.6 * (1.0 - t)), petal);
  float lw = fwidth(edge) * 1.5 + 1e-4;
  col += pal(0.1 + uBeats * 0.05 + uVar.w) * smoothstep(lw, 0.0, abs(edge)) * (0.6 + uKick);
  col += tile * 0.15 * smoothstep(fwidth(z.y) * 1.5, 0.0, z.y);
  float wave = exp(-pow(depth - mod(uBeats, 6.0), 2.0) * 2.0);
  col += tile * wave * (0.15 * uMusic + 0.8 * uKick);
  return col * smoothstep(1.0, 0.9, rr) + halo;
}
`;

// Reaction-diffusion, read from its own simulation (TURING_STEP, sims.js):
// B, the chemical that eats the feed, in relief, wet, with the edge of every
// pattern glowing with the lead. The view turns slowly over the torus.
const TURING = `
uniform sampler2D uState;

// B at uv, bilinear by hand (the state is float, so it is not filterable everywhere).
float chem(vec2 uv) {
  ivec2 s = textureSize(uState, 0);
  vec2 t = uv * vec2(s) - 0.5;
  vec2 f = fract(t);
  ivec2 a = (ivec2(floor(t)) + s * 16) % s, b = (a + 1) % s;
  return mix(
    mix(texelFetch(uState, a, 0).g, texelFetch(uState, ivec2(b.x, a.y), 0).g, f.x),
    mix(texelFetch(uState, ivec2(a.x, b.y), 0).g, texelFetch(uState, b, 0).g, f.x), f.y);
}

vec3 scene(vec2 uv) {
  vec2 size = vec2(textureSize(uState, 0));
  vec2 asp = vec2(size.x / size.y, 1.0);
  vec2 q = rot((uTime + 0.5 * uPush) * 0.02) * ((vUv - 0.5) * asp) * 0.85;
  vec2 suv = q / asp + 0.5;
  float b = chem(suv);
  vec2 g = vec2(chem(suv + vec2(1.0 / size.x, 0.0)) - b, chem(suv + vec2(0.0, 1.0 / size.y)) - b);
  vec3 nor = normalize(vec3(-g * (5.0 + 2.0 * uSurge), 1.0));
  vec3 L = normalize(vec3(cos(uTime * 0.3), sin(uTime * 0.3), 1.2));
  float dif = max(dot(nor, L), 0.0);
  float spec = pow(max(dot(nor, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 30.0);
  float v = smoothstep(0.1, 0.35, b);
  vec3 col = mix(pal(0.6 + uVar.w + uTime * 0.01) * 0.06, pal(b * 2.0 + uTime * 0.02 + uVar.w), v);
  col = col * (0.35 + 0.9 * dif) + spec * 0.5 * v;
  col += pal(0.3 + uVar.w) * exp(-abs(b - 0.2) * 40.0) * (0.15 + 0.8 * uLead + 0.3 * uKick);
  return col;
}
`;

// Physarum, read from its own simulation (sims.js): the trail its agents
// leave, as a glowing network, hottest where the veins are thickest.
const PHYSARUM = `
uniform sampler2D uState;

vec3 scene(vec2 uv) {
  float t = texture(uState, vUv).r;
  float g = 1.0 - exp(-t / 30.0);
  vec3 col = pal(g * 0.6 + uTime * 0.02 + uVar.w) * pow(g, 1.5) * 1.5;
  col += pal(0.1 + uVar.w) * pow(g, 6.0) * (0.5 + uKick);
  return col;
}
`;

const SCENE_MAIN = `
void main() {
  outColor = vec4(tone(scene(screen())), 1.0);
}
`;

export const SCENES = {
  bulb: BULB,
  kifs: KIFS,
  mandala: MANDALA,
  flow: FLOW,
  julia: JULIA,
  gyroid: GYROID,
  coral: CORAL,
  cells: CELLS,
  phyllo: PHYLLO,
  hyper: HYPER,
  turing: TURING,
  physarum: PHYSARUM,
};

/** The fragment source of scene `id`. */
export const sceneSource = (id) => COMMON + SCENES[id] + SCENE_MAIN;

// Gray-Scott reaction-diffusion, one step on a torus: A is fed in, B eats
// it and dies off (Karl Sims' constants: Da 1, Db 0.5, dt 1). Four regimes
// (uVar.x): coral, mitosis, a maze and worms. It starts as A with drops of
// B scattered over it, and the kick drops more B on a spot hashed per beat.
export const TURING_STEP = `${COMMON}
uniform sampler2D uState;
uniform float uReset;
const vec2 FK[4] = vec2[4](vec2(0.0545, 0.062), vec2(0.0367, 0.0649), vec2(0.029, 0.057), vec2(0.078, 0.061));

vec2 at(ivec2 c, ivec2 s) {
  return texelFetch(uState, (c + s) % s, 0).rg;
}

void main() {
  ivec2 s = textureSize(uState, 0);
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / vec2(s);
  float aspect = float(s.x) / float(s.y);
  if (uReset > 0.5) {
    vec2 g = uv * vec2(aspect, 1.0) * 10.0;
    float drop = hash21(floor(g) + uVar.z * 37.0) < 0.3 && length(fract(g) - 0.5) < 0.2 ? 1.0 : 0.0;
    outColor = vec4(1.0 - 0.5 * drop, 0.5 * drop, 0.0, 1.0);
    return;
  }
  vec2 v = at(c, s);
  vec2 lap = 0.2 * (at(c + ivec2(1, 0), s) + at(c - ivec2(1, 0), s) + at(c + ivec2(0, 1), s) + at(c - ivec2(0, 1), s))
    + 0.05 * (at(c + ivec2(1, 1), s) + at(c - ivec2(1, 1), s) + at(c + ivec2(1, -1), s) + at(c - ivec2(1, -1), s)) - v;
  vec2 fk = FK[int(uVar.x * 4.0)];
  float r = v.x * v.y * v.y;
  vec2 next = v + vec2(lap.x - r + fk.x * (1.0 - v.x), 0.5 * lap.y + r - (fk.x + fk.y) * v.y);
  float beat = floor(uBeats);
  vec2 d = uv - vec2(hash21(vec2(beat, 1.7)), hash21(vec2(beat, 9.3)));
  d = (d - floor(d + 0.5)) * vec2(aspect, 1.0);
  next.y += uKick * 0.08 * smoothstep(0.05, 0.03, length(d));
  outColor = vec4(clamp(next, 0.0, 1.0), 0.0, 1.0);
}
`;

// Physarum (Jeff Jones' slime mould model), its agents' step: each one
// smells the trail ahead, ahead-left and ahead-right, turns towards the
// strongest and moves on. Agents live in a float texture as (x, y, heading),
// x and y in 0..1 of the trail, headings in its pixels. Four species
// (uVar.x: sensor angle, turn, sensor distance, speed), three ways to start
// (uVar.y): scattered, a ring and a disc, both facing out. The bass makes
// them smell further, the kick runs them faster, the hats shake their turns.
export const PHYSARUM_AGENTS = `${COMMON}
uniform sampler2D uAgents, uTrail;
uniform float uReset, uStep;
const vec4 SPECIES[4] = vec4[4](vec4(0.39, 0.79, 9.0, 1.0), vec4(0.79, 0.79, 9.0, 1.0), vec4(0.5, 0.3, 20.0, 1.4), vec4(1.0, 0.5, 5.0, 0.8));

float smell(vec2 pos, float ang, float dist, vec2 res) {
  return texture(uTrail, pos + vec2(cos(ang), sin(ang)) * dist / res).r;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 res = vec2(textureSize(uTrail, 0));
  float r1 = hash31(vec3(vec2(c), uStep + 0.5));
  float r2 = hash31(vec3(vec2(c) + 0.5, uStep + 7.0));
  if (uReset > 0.5) {
    float r3 = hash31(vec3(vec2(c) + 0.25, 13.0 + uVar.z * 17.0));
    float r4 = hash31(vec3(vec2(c) + 0.75, 29.0 + uVar.z * 17.0));
    vec2 squash = vec2(res.y / res.x, 1.0);
    float start = floor(uVar.y * 3.0), ang = r3 * TAU;
    if (start < 1.0) outColor = vec4(r3, r4, r1 * TAU, 0.0);
    else if (start < 2.0) outColor = vec4(0.5 + vec2(cos(ang), sin(ang)) * squash * (0.3 + 0.03 * r4), ang, 0.0);
    else outColor = vec4(0.5 + vec2(cos(ang), sin(ang)) * squash * 0.2 * sqrt(r4), ang, 0.0);
    return;
  }
  vec4 a = texelFetch(uAgents, c, 0);
  vec4 sp = SPECIES[int(uVar.x * 4.0)];
  float dist = sp.z * (1.0 + 0.5 * uBass);
  float h = a.z;
  float f = smell(a.xy, h, dist, res), l = smell(a.xy, h + sp.x, dist, res), r = smell(a.xy, h - sp.x, dist, res);
  if (f < l && f < r) h += (r1 < 0.5 ? 1.0 : -1.0) * sp.y;
  else if (l > f && l > r) h += sp.y;
  else if (r > f && r > l) h -= sp.y;
  h += (r2 - 0.5) * 0.6 * uPerc;
  vec2 pos = fract(a.xy + vec2(cos(h), sin(h)) * sp.w * (1.0 + 1.5 * uKick) / res);
  outColor = vec4(pos, mod(h, TAU), 0.0);
}
`;

// Physarum's deposit: one point per agent, added onto the trail.
export const PHYSARUM_POINTS = `#version 300 es
uniform sampler2D uAgents;
void main() {
  int w = textureSize(uAgents, 0).x;
  vec4 a = texelFetch(uAgents, ivec2(gl_VertexID % w, gl_VertexID / w), 0);
  gl_Position = vec4(a.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

export const PHYSARUM_DEPOSIT = `#version 300 es
precision highp float;
uniform float uDeposit;
out vec4 outColor;
void main() {
  outColor = vec4(uDeposit, 0.0, 0.0, 1.0);
}`;

// Physarum's trail: a 3×3 blur that fades, on a torus.
export const PHYSARUM_DIFFUSE = `${COMMON}
uniform sampler2D uTrail;
void main() {
  ivec2 s = textureSize(uTrail, 0);
  ivec2 c = ivec2(gl_FragCoord.xy);
  float sum = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) sum += texelFetch(uTrail, (c + ivec2(i, j) + s) % s, 0).r;
  }
  float v = texelFetch(uTrail, c, 0).r;
  outColor = vec4(mix(v, sum / 9.0, 0.35) * 0.93, 0.0, 0.0, 1.0);
}
`;

export const POST = `${COMMON}
uniform sampler2D uScene, uPrev, uFeed, uBloom;
uniform float uMix, uStrobe, uTrails, uInvert, uHaze;

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
  // The camera's tremor (uShake), in short-side units; the trails stay
  // where they were, so a shake smears the edges into colour.
  vec2 uv = 0.5 + rot(uShake.z) * (lens(vUv) - 0.5) + uShake.xy * min(uRes.x, uRes.y) / uRes;
  vec2 d = vUv - 0.5;
  // Colour fringes: always a little towards the edges, more on the kick and the tremor.
  float split = 0.004 * uKick + 0.01 * uGlitch + 0.006 * uDrop + 0.012 * dot(d, d) + 0.8 * length(uShake.xy);
  vec3 col = sceneAt(uScene, uv, split);
  if (uMix < 1.0) {
    // The scene going out zooms away while the new one comes in.
    vec2 zuv = 0.5 + (uv - 0.5) / (1.0 + uMix * 0.4);
    col = mix(sceneAt(uPrev, zuv, split), col, smoothstep(0.0, 1.0, uMix));
  }
  // Trails: the last frame, a little zoomed and turned, where it is brighter.
  vec2 fuv = 0.5 + (vUv - 0.5) * rot(0.004 * sin(uTime * 0.3)) * (0.985 - 0.012 * uSurge);
  col = max(col, texture(uFeed, fuv).rgb * uTrails);

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
