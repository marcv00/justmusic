const noise = /* glsl */ `
float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1.0,0.0)), u.x),
             mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

export const worldVertex = /* glsl */ `
varying vec2 vP;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * The wall. Three castings share one lighting rig: the breeze-block lattice (lens openings
 * between overlapping discs), rings (an annulus around a centre dot in every cell) and a
 * honeycomb. Light comes from "looks": rings and squares born in the centre that grow out of
 * frame, a sweep, a radar beam, a two-group checker and a column chase, all locked to the
 * beat and bar and crossfaded on phrase changes. The bass sets how bright the look burns.
 */
export const wallFragment = /* glsl */ `
uniform float uTime, uCell, uLow, uMid, uKick, uSnare, uEnergy, uRiser, uFlash;
uniform float uDrift, uReveal, uWallLight, uIntensity, uPalMix, uGeom, uClock, uZone;
uniform vec2 uView;
uniform vec3 uLook;      // look A, look B, mix
uniform vec4 uBeatInfo;  // beat phase, bar phase, beat index, bar index
uniform vec2 uTiming;    // beat period, light decay (s)
uniform vec4 uRings[10]; // birth (uClock), strength, shape, travel (s)
uniform vec3 uWallA, uWallB, uA0, uA1, uA2, uB0, uB1, uB2;
varying vec2 vP;
${noise}
float sdVesica(vec2 p, float r, float d){
  p = abs(p);
  float b = sqrt(r*r - d*d);
  return ((p.y-b)*d > p.x*b) ? length(p-vec2(0.0,b)) : length(p-vec2(-d,0.0)) - r;
}
float sdHex(vec2 p, float r){
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0*min(dot(k.xy, p), 0.0)*k.xy;
  p -= vec2(clamp(p.x, -k.z*r, k.z*r), r);
  return length(p)*sign(p.y);
}
vec3 cycle3(vec3 c0, vec3 c1, vec3 c2, float h){
  h = fract(h) * 3.0;
  if (h < 1.0) return mix(c0, c1, smoothstep(0.0, 1.0, h));
  if (h < 2.0) return mix(c1, c2, smoothstep(0.0, 1.0, h - 1.0));
  return mix(c2, c0, smoothstep(0.0, 1.0, h - 2.0));
}
float palWipe(vec2 c01, float seed){
  float r = length((c01 - 0.5) * vec2(uView.x / uView.y, 1.0));
  return smoothstep(0.0, 0.22, uPalMix * 1.6 - r * 0.75 - seed * 0.06);
}

/* ---------- castings: centre of the lit cell, distance to its opening, group, relief ---------- */
void cellLattice(vec2 q, out vec2 center, out float d, out float group, out float relief, out float depthScale){
  vec2 cv = vec2(floor(q.x) + 0.5, floor(q.y + 0.5));
  vec2 ch = vec2(floor(q.x + 0.5), floor(q.y) + 0.5);
  float dv = sdVesica(q - cv, 0.6, 0.5);
  float dh = sdVesica((q - ch).yx, 0.6, 0.5);
  group = dv < dh ? 1.0 : 0.0;
  d = min(dv, dh);
  center = group > 0.5 ? cv : ch;
  float gd = 1e3;
  vec2 base = floor(q);
  for (int a = 0; a < 2; a++) for (int c = 0; c < 2; c++){
    gd = min(gd, abs(length(q - (base + vec2(float(a), float(c)))) - 0.62));
  }
  relief = gd;
  depthScale = 0.1;
}
void cellRings(vec2 q, out vec2 center, out float d, out float group, out float relief, out float depthScale){
  center = floor(q) + 0.5;
  vec2 l = q - center;
  float r = length(l);
  float annulus = abs(r - 0.3) - 0.052;
  float dot_ = r - 0.085;
  d = min(annulus, dot_);
  group = mod(floor(q.x) + floor(q.y), 2.0);
  relief = abs(r - 0.455);
  depthScale = 0.05;
}
void cellHex(vec2 q, out vec2 center, out float d, out float group, out float relief, out float depthScale){
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(q, q - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec4 h = vec4(q - hc.xy * s, q - (hc.zw + 0.5) * s);
  vec2 l; vec2 id;
  if (dot(h.xy, h.xy) < dot(h.zw, h.zw)) { l = h.xy; id = hc.xy; } else { l = h.zw; id = hc.zw + 0.5; }
  center = q - l;
  // the cell is a pointy-top hexagon; the opening follows it
  vec2 lr = vec2(l.y, l.x);
  d = sdHex(lr, 0.34);
  group = mod(floor(id.x) + floor(id.y * 2.0), 2.0);
  relief = abs(sdHex(lr, 0.5));
  depthScale = 0.12;
}

/* ---------- looks ---------- */
float ringsLook(vec2 P, float maxR, float dec){
  float acc = 0.0;
  for (int k = 0; k < 10; k++){
    vec4 r = uRings[k];
    float age = uClock - r.x;
    if (age < 0.0 || age > r.w * 1.4) continue;
    float rad = age / r.w * maxR;
    float dist = r.z < 0.5 ? length(P) : r.z < 1.5 ? max(abs(P.x), abs(P.y)) * 1.12 : (abs(P.x) + abs(P.y)) * 0.8;
    float w = 0.06 + 0.06 * (1.0 - uEnergy) + 0.03 * dec;
    float front = exp(-((dist - rad) * (dist - rad)) / (w * w));
    // what the shape has passed keeps a fading glow, longer when the music is calm
    float trail = dist < rad ? exp(-(rad - dist) / (0.08 + 0.4 * dec)) * 0.22 : 0.0;
    acc = max(acc, (front + trail) * r.y);
  }
  return acc;
}
/* drift: soft zones of the wall rise and fall in turn; each lives uZone seconds */
float driftLook(vec2 P, float aspect){
  float half_ = max(0.75, uZone * 0.5);
  float ph = uClock / half_;
  float base = floor(ph);
  float acc = 0.0;
  for (int k = -1; k <= 0; k++){
    float idx = base + float(k);
    vec2 c = (vec2(hash21(vec2(idx, 3.7)), hash21(vec2(idx, 9.1))) * 2.0 - 1.0) * vec2(aspect * 0.78, 0.72);
    float w = ph - idx;                                   // 0..2 across its life
    float life = smoothstep(0.0, 1.0, w) * (1.0 - smoothstep(1.0, 2.0, w));
    float d = length(P - c);
    acc += life * exp(-(d * d) / 0.32);
  }
  return acc;
}

float look(float id, vec2 P, float group, float maxR){
  float bp = uBeatInfo.x, barp = uBeatInfo.y, bi = uBeatInfo.z, bri = uBeatInfo.w;
  float per = max(0.2, uTiming.x), dec = max(0.06, uTiming.y);
  float env = exp(-bp * per / dec);                       // a hit on the beat, lingering by mood
  float aspect = uView.x / uView.y;
  if (id > 5.5) return driftLook(P, aspect);
  if (id < 0.5){                                          // breathe: the whole wall inhales each bar
    float s = 0.5 - 0.5 * cos(barp * 6.2831853);
    return (0.2 + 0.8 * s) * (1.0 - 0.3 * length(P) / maxR);
  }
  if (id < 1.5) return driftLook(P, aspect);              // (shapes are accents now, drawn on top)
  if (id < 2.5){                                          // sweep: a curtain of light per bar, alternating direction
    float dir = mod(bri, 2.0) < 0.5 ? 1.0 : -1.0;
    float pos = mix(-aspect - 0.3, aspect + 0.3, barp) * dir;
    float dx = (P.x - pos) * dir;
    float head = exp(-(dx * dx) / 0.012);
    float tail = dx < 0.0 ? exp(dx / (0.2 + 0.8 * dec)) * 0.5 : 0.0;
    return max(head, tail) * (0.75 + 0.25 * env);
  }
  if (id < 3.5){                                          // radar: one turn per bar, direction flips each bar
    float dir = mod(bri, 2.0) < 0.5 ? 1.0 : -1.0;
    float a = atan(P.y, P.x);
    float beam = barp * 6.2831853 * dir;
    float da = (mod(a - beam + 3.14159265, 6.2831853) - 3.14159265) * dir;
    float head = exp(-(da * da) / 0.03);
    float tail = da < 0.0 ? exp(da / (0.5 + 1.5 * dec)) * 0.5 : 0.0;
    float hub = (1.0 - smoothstep(0.0, 0.35, length(P))) * env * 0.6;
    return max(head, tail) * smoothstep(0.05, 0.3, length(P)) + hub;
  }
  if (id < 4.5){                                          // checker: two families of cells trade the beat
    float on = abs(group - mod(bi, 2.0)) < 0.5 ? 1.0 : 0.0;
    return on * (0.2 + 0.8 * env) + (1.0 - on) * 0.05;
  }
  // columns: a chase that bounces across six columns, one per beat
  float n = 6.0;
  float col = floor(clamp(P.x / aspect * 0.5 + 0.5, 0.0, 0.999) * n);
  float stp = mod(bi, 2.0 * n - 2.0);
  float lit = stp < n ? stp : 2.0 * n - 2.0 - stp;
  float dc = abs(col - lit);
  float on = dc < 0.5 ? 1.0 : dc < 1.5 ? 0.22 : 0.0;
  return on * (0.3 + 0.7 * env);
}

void main(){
  // denser castings so circles and squares read as shapes, not blocks
  float scale = uGeom < 0.5 ? 0.74 : uGeom < 1.5 ? 0.5 : 0.48;
  vec2 q = vP / (uCell * scale);
  vec2 center; float d; float group; float relief; float depthScale;
  if (uGeom < 0.5) cellLattice(q, center, d, group, relief, depthScale);
  else if (uGeom < 1.5) cellRings(q, center, d, group, relief, depthScale);
  else cellHex(q, center, d, group, relief, depthScale);
  vec2 l = q - center;

  vec2 cw = center * uCell * scale;
  float seed = hash21(center * 2.0 + group * 0.44 + 0.37);
  vec2 c01 = cw / uView * 0.5 + 0.5;
  vec2 p01 = vP / uView * 0.5 + 0.5;
  vec2 P = cw / uView.y;                                  // centre-origin, round circles
  float maxR = length(uView / uView.y) + 0.2;

  // colour: a slow field walks the scene's three lights across the wall
  float h = c01.x * 0.55 + 0.22 * sin(c01.y * 3.1 + uTime * 0.21) + uTime * 0.012 + uDrift * 0.25 + seed * 0.07;
  float pm = palWipe(c01, seed);
  vec3 holeCol = mix(cycle3(uA0, uA1, uA2, h), cycle3(uB0, uB1, uB2, h), pm);

  // the light: choreography × how hard the bass is pushing
  float dec0 = max(0.06, uTiming.y);
  float L = mix(look(uLook.x, P, group, maxR), look(uLook.y, P, group, maxR), uLook.z) * 0.85
          + ringsLook(P, maxR, dec0);
  float pump = uLow * uLow * (3.0 - 2.0 * uLow);
  float e = 0.6 + 0.5 * uEnergy;
  float tw = 0.5 + 0.5 * sin(uTime * 0.7 + seed * 6.2831);
  float b = (0.025 + 0.035 * tw) * e;                     // never quite dark
  b += L * (0.5 + 0.7 * pump + 0.25 * uKick) * uIntensity * e;
  b += pump * 0.07 * uIntensity;                          // a whisper of bass in every opening
  b += uRiser * (0.2 + 0.3 * fract(seed * 13.0 + uTime * 0.5));
  b += uFlash * 0.9;

  // reveal: lights strike left to right with a short fluorescent stutter
  float rv = smoothstep(0.0, 0.18, uReveal * 1.45 - c01.x - 0.1 + seed * 0.12);
  float stutter = step(0.45, hash21(vec2(floor(uTime * 18.0), seed * 97.0)));
  float on = rv * mix(stutter, 1.0, smoothstep(0.55, 1.0, rv));
  b = clamp(b, 0.0, 1.6) * on;

  float aa = fwidth(d) * 0.9;
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float depth = clamp(-d / depthScale, 0.0, 1.0);
  vec3 emiss = holeCol * (0.07 + 2.6 * b) * (0.75 + 0.5 * depth);   // unlit openings stay dim so the looks read
  emiss += mix(holeCol, vec3(1.0, 0.97, 0.95), 0.6) * pow(depth, 1.4) * b * b * 3.0;
  emiss *= mix(0.45, 1.0, smoothstep(0.0, 0.4, depth));
  emiss += holeCol * 0.02;

  // concrete washed by the scene colour
  vec3 wallTint = mix(uWallA, uWallB, palWipe(p01, 0.0));
  float grainN = fbm(vP * 2.6);
  float pores = vnoise(vP * 38.0);
  vec3 albedo = wallTint * (0.7 + 0.42 * grainN + 0.08 * pores);
  vec2 Pp = vP / uView.y;
  float Lp = mix(look(uLook.x, Pp, group, maxR), look(uLook.y, Pp, group, maxR), uLook.z) * 0.85
           + ringsLook(Pp, maxR, dec0);
  float flood = uWallLight * (0.26 + 0.3 * uLow * uIntensity + 0.32 * Lp * uIntensity + 0.18 * uKick * uIntensity) * (1.0 - uRiser * 0.45) * (0.75 + 0.35 * uEnergy);
  flood += uFlash * 0.6;
  float sweepX = sin(uTime * 0.13) * uView.x * 0.85;
  float sweep = exp(-pow((vP.x - sweepX) / (uView.x * 0.7), 2.0));
  float vgrad = smoothstep(-uView.y * 1.15, uView.y * 0.1, vP.y) * mix(1.0, 0.55, smoothstep(uView.y * 0.2, uView.y * 1.2, vP.y));
  vec3 lit = albedo * flood * (0.45 + 0.75 * sweep) * (0.2 + 0.8 * vgrad);

  // relief of the casting: a groove whose upper lip catches light, slightly domed cells
  float groove = smoothstep(0.035, 0.0, relief);
  lit *= 1.0 - groove * 0.55;
  lit += albedo * groove * (0.5 + 0.2 * sign(l.y)) * 0.12 * flood;   // upper edges catch a little more light
  lit *= 0.85 + 0.25 * smoothstep(0.62, 0.0, length(l));

  float spill = exp(-max(d, 0.0) * 14.0) * (0.15 + b);
  lit += holeCol * spill * 0.55 * on;
  float rim = smoothstep(0.028, 0.0, d) * smoothstep(-0.004, 0.006, d);
  lit += holeCol * rim * (0.2 + b) * 0.45 * on;

  gl_FragColor = vec4(mix(lit, emiss, inside), 1.0);
}
`;

/** A sheet of slow drifting fog between the wall and the camera, denser near the floor. */
export const hazeFragment = /* glsl */ `
uniform float uTime, uStrength, uKick, uBass;
uniform vec3 uRed, uIce;
uniform vec2 uView;
varying vec2 vP;
${noise}
// uRed = the scene's wall wash, uIce = its second light
void main(){
  vec2 p = vP;
  float n1 = fbm(p*0.32 + vec2(uTime*0.018, -uTime*0.011));
  float n2 = fbm(p*0.75 + vec2(-uTime*0.027, uTime*0.009) + n1*1.5);
  float fog = smoothstep(0.3, 0.95, n1*0.6 + n2*0.6);
  float low = smoothstep(uView.y*1.1, -uView.y*0.8, p.y);
  float x01 = p.x/uView.x*0.5 + 0.5;
  vec3 c = mix(uRed, uIce*0.55, smoothstep(0.35, 1.1, x01)*0.4);
  float a = fog * (0.35 + 0.65*low) * uStrength * (0.7 + 0.5*uBass + 0.6*uKick);
  gl_FragColor = vec4(c*a, 1.0);
}
`;

/** Dust motes hanging in the light. Out-of-focus ones grow and fade like bokeh. */
export const dustVertex = /* glsl */ `
attribute float aSeed;
attribute float aSize;
uniform float uTime, uPR, uKick, uHeight, uFocus;
varying float vAlpha;
varying float vX;
void main(){
  vec3 p = position;
  float t = uTime;
  p.y = mod(p.y + t*(0.04 + aSeed*0.07) + uHeight, uHeight*2.0) - uHeight;
  p.x += sin(t*0.17 + aSeed*31.0)*0.35 + sin(t*0.05 + aSeed*7.0)*0.6;
  p.z += sin(t*0.11 + aSeed*13.0)*0.25;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = -mv.z;
  float blur = abs(dist - uFocus);
  gl_PointSize = aSize * uPR * (1.0 + blur*0.9) * (260.0/dist);
  vAlpha = (0.55/(1.0 + blur*blur*0.6)) * (0.6 + 0.4*sin(t*0.7 + aSeed*40.0)) * (1.0 + uKick*0.6);
  vX = p.x;
  gl_Position = projectionMatrix * mv;
}
`;

export const dustFragment = /* glsl */ `
uniform vec3 uRed, uIce;
uniform float uViewX, uStrength;
varying float vAlpha;
varying float vX;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = exp(-dot(c, c)*12.0) * vAlpha * uStrength;
  if (a < 0.002) discard;
  vec3 tint = mix(uRed, uIce, smoothstep(-0.2, 1.0, vX/uViewX*0.5 + 0.5));
  vec3 col = mix(vec3(1.0, 0.45, 0.4), tint, 0.75);
  gl_FragColor = vec4(col*a, 1.0);
}
`;

/** Final grade, in linear HDR before tone mapping: lens fringe, saturation, black floor, vignette, film grain. */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: [1, 1] },
    uGrain: { value: 1 },
    uCA: { value: 0.002 },
    uSat: { value: 1.04 },
    uBlack: { value: 0.004 },
    uVignette: { value: 0.75 },
    uFade: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uCA, uSat, uBlack, uVignette, uFade;
    uniform vec2 uRes;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 dir = vUv - 0.5;
      float r2 = dot(dir, dir);
      vec2 o = dir * uCA * (0.4 + r2*2.0);
      vec3 c = vec3(texture2D(tDiffuse, vUv - o).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + o).b);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);
      c = max(c - uBlack, 0.0);
      float v = smoothstep(0.95, 0.15, length(dir*vec2(1.0, 0.82))*1.25);
      c *= mix(1.0 - uVignette, 1.0, v);
      float g = h(vUv*uRes + fract(uTime*7.13)*311.0) - 0.5;
      c += g * uGrain * (0.006 + sqrt(max(l, 0.0))*0.025);
      gl_FragColor = vec4(max(c, 0.0) * uFade, 1.0);
    }
  `,
};

/**
 * "Onda": a dark hill with a lit crest and a spectral glow rising behind it. The crest height
 * comes from the live spectrum, bass in the middle and highs toward the edges; two layered
 * hills drift slowly so the horizon is never static.
 */
export const WaveShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uSpec;
    uniform sampler2D uSwell;   // recent energy: 0 = now (centre) … 1 = a few seconds ago (edges)
    uniform float uTime, uLevel, uKick, uFlash, uAspect, uIntensity, uFade;
    uniform vec3 uTint;
    uniform float uTintMix;
    uniform vec3 uArt;          // the album cover's colour
    uniform float uArtMix;
    varying vec2 vUv;

    vec3 spectral(float x){
      // indigo → violet → rose → amber → gold → green → teal → blue
      vec3 c0 = vec3(0.10, 0.18, 1.00);
      vec3 c1 = vec3(0.48, 0.30, 1.00);
      vec3 c2 = vec3(1.00, 0.45, 0.75);
      vec3 c3 = vec3(1.00, 0.62, 0.30);
      vec3 c4 = vec3(1.00, 0.86, 0.20);
      vec3 c5 = vec3(0.30, 0.95, 0.35);
      vec3 c6 = vec3(0.15, 0.80, 0.85);
      vec3 c7 = vec3(0.12, 0.35, 1.00);
      x = clamp(x, 0.0, 1.0) * 7.0;
      if (x < 1.0) return mix(c0, c1, x);
      if (x < 2.0) return mix(c1, c2, x - 1.0);
      if (x < 3.0) return mix(c2, c3, x - 2.0);
      if (x < 4.0) return mix(c3, c4, x - 3.0);
      if (x < 5.0) return mix(c4, c5, x - 4.0);
      if (x < 6.0) return mix(c5, c6, x - 5.0);
      return mix(c6, c7, x - 6.0);
    }
    float spec(float u){
      u = clamp(u, 0.0, 1.0) * 0.96 + 0.02;
      float s = texture2D(uSpec, vec2(u, 0.5)).r * 0.3;
      s += (texture2D(uSpec, vec2(u - 0.035, 0.5)).r + texture2D(uSpec, vec2(u + 0.035, 0.5)).r) * 0.22;
      s += (texture2D(uSpec, vec2(u - 0.07, 0.5)).r + texture2D(uSpec, vec2(u + 0.07, 0.5)).r) * 0.13;
      return s;
    }
    // what sounded a moment ago, travelling out from the centre like a wave reaching the shore
    float swell(float d){
      d = clamp(d, 0.0, 1.0) * 0.97 + 0.015;
      return (texture2D(uSwell, vec2(d - 0.02, 0.5)).r + 2.0*texture2D(uSwell, vec2(d, 0.5)).r + texture2D(uSwell, vec2(d + 0.02, 0.5)).r) * 0.25;
    }
    // crest height for a layer
    float crest(float x, float phase, float scale){
      float cx = 0.5 + 0.13*sin(uTime*0.05 + phase);
      float band = abs(x - cx) * 1.7;
      float s = spec(band);
      float hills = 0.05*sin(x*5.5 + uTime*0.11 + phase) + 0.03*sin(x*11.0 - uTime*0.17 + phase*2.0);
      float h = 0.13 + hills + scale*s*(1.0 - 0.45*clamp(band, 0.0, 1.0)) + uKick*0.025*scale;
      // the swell grows as it nears the edges, then breaks gently at the frame
      float d = clamp(abs(x - cx) * 2.0, 0.0, 1.0);
      h += scale * 0.55 * swell(d) * smoothstep(0.08, 0.6, d) * (1.0 - 0.35 * smoothstep(0.85, 1.0, d));
      return min(h, 0.42 - 0.04*phase*0.3);
    }
    float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }

    void main(){
      vec2 uv = vUv;
      float x = uv.x;
      float sMid = (spec(abs(x - 0.5) * 1.7) * 0.5 + spec(abs(x - 0.42) * 1.7) * 0.25 + spec(abs(x - 0.58) * 1.7) * 0.25);

      float hBack = crest(x, 1.7, 0.24);
      float hFront = crest(x, 0.0, 0.29) - 0.035;
      float dBack = uv.y - hBack;
      float dFront = uv.y - hFront;

      vec3 col = spectral(x + 0.04*sin(uTime*0.04));
      col = mix(col, uTint, uTintMix);
      // the centre takes the cover's colour instead of washing out to white
      float centre = exp(-pow((x - 0.5) / 0.17, 2.0)) * uArtMix;
      col = mix(col, uArt, centre * 0.8);
      float whiten = 1.0 - centre * 0.85;

      // light rising behind the hills
      float rise = exp(-max(dBack, 0.0) * mix(7.5, 3.2, sMid)) * (0.25 + 0.9*sMid + 0.5*uLevel);
      float wash = smoothstep(1.1, 0.0, uv.y) * (0.1 + 0.35*uLevel);
      vec3 c = col * (rise * 1.25 + wash);

      // back hill: dim body, soft lit crest
      float backBody = smoothstep(0.004, -0.004, dBack);
      vec3 backCol = col * (0.05 + 0.35*exp(dBack*14.0)) ;
      c = mix(c, backCol, backBody * 0.85);
      c += mix(col, vec3(1.0), 0.35 * whiten) * exp(-abs(dBack)*220.0) * (0.35 + 1.1*sMid);

      // front hill: darker, crisp crest that blooms
      float frontBody = smoothstep(0.003, -0.003, dFront);
      vec3 frontCol = col * 0.02 + col * 0.25 * exp(dFront*22.0);
      c = mix(c, frontCol, frontBody);
      c += mix(col, vec3(1.0), 0.5 * whiten) * exp(-abs(dFront)*320.0) * (0.5 + 1.8*sMid) * uIntensity;

      // sprinkles: specks of the cover's colour twinkling in the light above the centre
      vec2 grid = uv * vec2(150.0 * uAspect / 1.78, 84.0);
      vec2 cell = floor(grid);
      float r = h21(cell);
      float soft = smoothstep(0.5, 0.0, length(fract(grid) - 0.5));
      float tw = 0.5 + 0.5 * sin(uTime * (0.8 + r * 2.2) + r * 40.0);
      float above = smoothstep(0.0, 0.03, dBack) * exp(-max(dBack, 0.0) * 3.2);
      c += uArt * step(0.955, r) * soft * tw * tw * above * centre * (0.6 + 1.6 * sMid + uLevel) * 1.4;

      c *= 1.0 + uFlash*0.8;
      // soft frame, like light in a dark room
      vec2 q = uv - 0.5;
      c *= smoothstep(0.85, 0.25, length(q*vec2(1.0, 1.25)));
      gl_FragColor = vec4(c * uFade, 1.0);
    }
  `,
};

/** Frosted glass: a jittered disc blur (the jitter is the frost), gentle waviness, a milky lift and a faint sheen. */
export const FrostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: [1, 1] },
    uAmount: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uAmount, uTime;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      if (uAmount < 0.002){ gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec2 uv = vUv;
      // the pane isn't perfectly flat
      uv += vec2(sin(uv.y*23.0 + uTime*0.05), cos(uv.x*19.0 - uTime*0.04)) * 0.0025 * uAmount;
      float r = uAmount * 0.05 * uRes.y;
      float a0 = h(floor(vUv*uRes)) * 6.2831;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 20; i++){
        float fi = float(i);
        float rr = sqrt((fi + 0.5) / 20.0) * r;
        float ang = a0 + fi * 2.39996;
        acc += texture2D(tDiffuse, uv + vec2(cos(ang), sin(ang)) * rr / uRes).rgb;
      }
      vec3 c = acc / 20.0;
      vec3 sharp = texture2D(tDiffuse, vUv).rgb;
      c = mix(sharp, c, smoothstep(0.0, 0.25, uAmount));
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c += (c * 0.18 + vec3(0.012, 0.013, 0.016)) * uAmount * 0.35;         // milky diffusion
      float sheen = exp(-pow((vUv.x*0.7 + vUv.y*0.3 - 0.35 - 0.08*sin(uTime*0.03)) * 3.2, 2.0));
      c += vec3(0.9, 0.95, 1.0) * sheen * 0.025 * uAmount * (0.4 + l);      // light across the glass
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};
