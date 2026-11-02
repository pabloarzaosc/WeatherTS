/**
 * GLSL (WebGL2) for the 3D view.
 *
 * Pass 1 marches each pixel's ray through the voxel box (a TEXTURE_3D, RGBA8:
 * r = value x echo, g = echo, b = seen) at a reduced render scale. Bricks with
 * nothing to draw are skipped whole (a coarse occupancy texture), and the ray
 * stops once what is in front hides the rest. The march starts at a jittered
 * offset that changes every frame; while the camera holds still the frames
 * are averaged (blended into the scene texture), so the jitter's grain melts
 * into a smooth picture. Pass 2 brings the picture up to the canvas with a
 * sharpening filter; pass 3 draws the box's hairlines.
 *
 * The storm look lights the cloud from the sun with a two-lobe Henyey-
 * Greenstein phase (a bright forward lobe: silver linings), a few weaker,
 * wider "octaves" for light scattered many times (dense cloud is bright
 * inside, not black), a powder darkening of the sunlit skin of thick cloud,
 * sky light from above and light bounced off the ground from below.
 */

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const MAX_FLASHES = 8;

export const VOLUME_FS = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 vUv;
out vec4 outColor;

uniform mat4 uInvViewProj;
uniform vec3 uEye;
uniform vec3 uBox;          // half x, half y (km), displayed top (km x vertical scale)
uniform vec3 uBricks;       // occupancy texture size
uniform sampler3D uVol;
uniform sampler3D uOcc;
uniform sampler2D uLut;     // 256 x 2: palette x curve, palette as it is
uniform sampler3D uNoise;   // tiling detail noise
uniform sampler2D uGroundTex;
uniform int uStyle;         // 0 storm, 1 radar
uniform vec2 uValRange;     // value at code 1 and code 254
uniform float uVScale;
uniform float uStep;
uniform float uSkip;        // occupancy max-code (0-1) under which a brick is empty
uniform float uCone;        // 1 draws the unseen cone, 0 hides it
uniform vec3 uSunDir;       // true direction (z not stretched)
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCloudEdge;   // dBZ
uniform float uCloudBase;   // km above the radar's ground
uniform float uDensity;
uniform float uExposure;
uniform vec4 uFlash[${MAX_FLASHES}];
uniform int uFlashCount;
uniform vec3 uRadar;
uniform vec3 uBg;
uniform vec3 uGround;
uniform vec3 uGrid;
uniform float uOpacity;
uniform float uGridKm;
uniform float uLod;         // mip level the storm look samples (softer cloud)
uniform float uFrame;       // which frame of the still-camera average
uniform vec2 uJitter;       // sub-pixel offset of this frame (NDC)
uniform float uShafts;      // 1 = sunbeams through the haze
uniform float uGroundOn;    // 1 = the map picture under the box
uniform vec2 uGeoCenter;    // box centre lat, lon (radians)
uniform vec4 uGeoMerc;      // picture west, east (radians), Mercator y south, north
uniform float uGroundHalf;  // half the picture's width, km
uniform vec4 uCut;          // plane normal x, y; offset (km); on
uniform vec2 uCutMode;      // cut away the near side (0/1); face opacity

vec3 tc(vec3 p) {
  return vec3((p.x + uBox.x) / (2.0 * uBox.x), (p.y + uBox.y) / (2.0 * uBox.y), p.z / uBox.z);
}

vec2 boxHit(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (bmin - o) * inv;
  vec3 t1 = (bmax - o) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// The storm look reads reflectivity as one continuous field: a voxel with no
// echo counts as a weak floor value rather than "nothing", so the filter
// blends values across an echo's edge (r = value x echo, g = echo, hence
// floor x (1 - g) + vmin x g + range x r). The on/off echo mask it used before
// stepped at every voxel level, and the cloud's sloping top showed those
// steps as rings.
const float FLOOR_DBZ = -10.0;
float dbzLin(vec4 s) {
  return mix(FLOOR_DBZ, uValRange.x, s.g) + (uValRange.y - uValRange.x) * s.r;
}

// Storm look, cheap: how dense the cloud is (for shadows, no detail).
float densityLite(vec4 s, float zr) {
  if (s.g < 0.004) return 0.0;
  float dbz = dbzLin(s);
  float cloud = smoothstep(uCloudEdge - 4.0, uCloudEdge + 5.0, dbz);
  float above = smoothstep(uCloudBase - 0.3, uCloudBase + 0.3, zr);
  return mix(smoothstep(22.0, 50.0, dbz) * 0.12, cloud * 0.85, above);
}

// Storm look: how dense the cloud (or the rain under it) is at one sample.
float stormDensity(vec4 s, vec3 p, out float dbz, out float below) {
  float echo = s.g;
  below = 0.0;
  dbz = -99.0;
  if (echo < 0.004) return 0.0;
  dbz = dbzLin(s);
  float zr = p.z / uVScale;
  // Billows: detail noise moves the cloud's edge in and out.
  float n = texture(uNoise, vec3(p.xy * 0.085, zr * 0.13)).r;
  float edge = uCloudEdge + (n - 0.5) * 10.0;
  float cloud = smoothstep(edge - 4.0, edge + 5.0, dbz) * (0.5 + 0.5 * smoothstep(uCloudEdge, 50.0, dbz));
  // The anvil: weak echo high up is thin ice, drawn thinner.
  float anvil = smoothstep(6.5, 10.5, zr) * (1.0 - smoothstep(26.0, 42.0, dbz));
  cloud *= 1.0 - 0.6 * anvil;
  // Under the base: rain in streaks that hang straight down, hail brighter.
  float streak = smoothstep(0.32, 0.78, texture(uNoise, vec3(p.xy * 0.75, zr * 0.03)).r);
  float rain = smoothstep(22.0, 50.0, dbz) * (0.05 + 0.2 * streak);
  float hail = smoothstep(52.0, 62.0, dbz) * 0.3;
  float above = smoothstep(uCloudBase - 0.3, uCloudBase + 0.3, zr);
  below = 1.0 - above;
  // Where the box cuts through the storm, a soft edge rather than a wall.
  float wall = min(uBox.x - abs(p.x), uBox.y - abs(p.y));
  return mix(rain + hail, cloud, above) * smoothstep(0.0, 1.4, wall);
}

vec3 sunDisplay() {
  return normalize(vec3(uSunDir.xy, uSunDir.z * uVScale));
}

// Optical depth toward the sun: a short march of growing steps.
float sunTau(vec3 p, vec3 sd, float lod, int n) {
  float tau = 0.0;
  float acc = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    float len = 0.35 * pow(1.65, float(i));
    vec3 q = p + sd * (acc + 0.5 * len);
    acc += len;
    if (q.z > uBox.z || q.z < 0.0 || abs(q.x) > uBox.x || abs(q.y) > uBox.y) break;
    tau += densityLite(textureLod(uVol, tc(q), lod), q.z / uVScale) * uDensity * len;
  }
  return tau;
}

// The ground's shadow: a longer march from the ground up to the box top.
float groundShadow(vec3 p, vec3 sd) {
  if (sd.z <= 0.02) return 1.0;
  float tau = 0.0;
  float acc = 0.2;
  for (int i = 0; i < 14; i++) {
    float len = 0.4 * pow(1.3, float(i));
    vec3 q = p + sd * (acc + 0.5 * len);
    acc += len;
    if (q.z > uBox.z || abs(q.x) > uBox.x || abs(q.y) > uBox.y) break;
    tau += densityLite(textureLod(uVol, tc(q), uLod + 1.0), q.z / uVScale) * uDensity * len;
  }
  return exp(-tau);
}

// Henyey-Greenstein, x 4 pi (1 = isotropic).
float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

// A forward lobe and a weaker backward one; k widens both (later octaves).
float phase2(float c, float k) {
  return mix(hg(c, 0.7 * k), hg(c, -0.22 * k), 0.3);
}

vec3 skyColor(vec3 d) {
  float h = clamp(d.z, 0.0, 1.0);
  vec3 c = mix(uHorizon, uZenith, pow(h, 0.45));
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  float up = smoothstep(-0.03, 0.02, uSunDir.z);
  c += uSunColor * (pow(sd, 1500.0) * 5.0 + pow(sd, 14.0) * 0.1) * up;
  return c;
}

// Radar palette colour of a voxel sample (row 1: the palette as it is).
vec4 paletteOf(vec4 s) {
  float v = clamp(s.r / max(s.g, 1e-4), 0.0, 1.0);
  return texture(uLut, vec2((1.0 + v * 253.0 + 0.5) / 256.0, 0.75));
}

// A display colour as the storm look's linear light (so the tone curve gives it back).
vec3 untone(vec3 c) {
  vec3 lin = pow(clamp(c, 0.0, 1.0), vec3(2.2));
  return -log(max(vec3(1.0) - lin, vec3(0.02))) / uExposure;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 + uJitter;
  vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0);
  vec3 ro = uEye;
  vec3 rd = normalize(b.xyz / b.w - a.xyz / a.w);
  vec3 rdSafe = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));

  // The ground (z = 0) under this pixel, worked out before any branching so
  // its screen derivatives (crisp grid lines, the picture's mip level) are defined.
  float tG = rd.z < -1e-5 ? -ro.z / rd.z : 1e9;
  vec3 gp = ro + rd * min(tG, 1e6);
  vec2 fw = max(fwidth(gp.xy), vec2(1e-4));
  // Where the ground point falls on the map picture (same projection as the voxels).
  vec2 guv = vec2(0.0);
  float gIn = 0.0;
  if (uGroundOn > 0.5) {
    float d = length(gp.xy);
    float lat = uGeoCenter.x;
    float lon = uGeoCenter.y;
    if (d > 1e-5) {
      float c = d / 6371.0;
      float az = atan(gp.x, gp.y);
      float sp = sin(uGeoCenter.x);
      float cp = cos(uGeoCenter.x);
      lat = asin(clamp(sp * cos(c) + cp * sin(c) * cos(az), -1.0, 1.0));
      lon = uGeoCenter.y + atan(sin(az) * sin(c) * cp, cos(c) - sp * sin(lat));
    }
    float my = log(tan(0.7853982 + lat * 0.5));
    guv = vec2((lon - uGeoMerc.x) / (uGeoMerc.y - uGeoMerc.x), (uGeoMerc.w - my) / (uGeoMerc.w - uGeoMerc.z));
    float m = max(abs(gp.x), abs(gp.y)) / uGroundHalf;
    gIn = tG < 1e8 ? 1.0 - smoothstep(0.62, 1.0, m) : 0.0;
  }
  vec2 gdx = dFdx(guv);
  vec2 gdy = dFdy(guv);

  vec3 bmin = vec3(-uBox.x, -uBox.y, 0.0);
  vec3 bmax = vec3(uBox.x, uBox.y, uBox.z);
  vec2 hit = boxHit(ro, rdSafe, bmin, bmax);
  float t0 = max(hit.x, 0.0);
  float t1 = min(hit.y, tG);

  // The cut: a vertical plane through the box.
  bool cutOn = uCut.w > 0.5;
  float sEye = dot(ro.xy, uCut.xy) - uCut.z;
  float dsC = dot(rd.xy, uCut.xy);
  float tCut = abs(dsC) > 1e-6 ? -sEye / dsC : -1.0;
  float tA = t0;
  float tB = t1;
  if (cutOn && uCutMode.x > 0.5) {
    // Only the far side of the plane is drawn.
    if (sEye * dsC < 0.0) tA = max(tA, tCut);
    else tB = tA;
  }
  bool cutFace = cutOn && tCut >= t0 && tCut <= t1;
  bool cutDone = !cutFace;

  vec3 col = vec3(0.0);
  float T = 1.0;
  vec3 sd = sunDisplay();
  float cosSun = dot(rd, sd);
  float away = 0.5 - 0.5 * cosSun;
  float tStop = t1;

  // Flashes: where along the ray each passes closest, and how close.
  float fT[${MAX_FLASHES}];
  float fD[${MAX_FLASHES}];
  bool fDone[${MAX_FLASHES}];
  for (int f = 0; f < ${MAX_FLASHES}; f++) {
    fDone[f] = f >= uFlashCount;
    vec3 v = uFlash[f].xyz - ro;
    fT[f] = dot(v, rd);
    fD[f] = length(v - rd * fT[f]);
  }

  // Interleaved gradient noise, moved on every frame of the average.
  vec2 fc = gl_FragCoord.xy + 5.588238 * uFrame;
  float jitter = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));

  if (tB > tA || !cutDone) {
    float t = tA + uStep * jitter;
    vec3 brick = vec3(2.0 * uBox.x, 2.0 * uBox.y, uBox.z) / uBricks;
    for (int i = 0; i < 1400; i++) {
      // The cut face, once the ray reaches it.
      if (!cutDone && (t >= tCut || t >= tB)) {
        cutDone = true;
        vec3 pc = ro + rd * tCut;
        vec4 s = textureLod(uVol, tc(pc), 0.0);
        vec4 pal = paletteOf(s);
        float echoA = smoothstep(0.08, 0.45, s.g) * pal.a;
        float glass = 0.1 * s.b;
        float al = clamp(uCutMode.y * max(echoA, glass), 0.0, 1.0);
        vec3 face = echoA > glass ? pal.rgb : (uStyle == 0 ? vec3(0.8) : uGrid);
        if (uStyle == 0) face = untone(face);
        col += T * al * face;
        T *= 1.0 - al;
      }
      if (t >= tB || T < 0.01) break;
      vec3 p = ro + rd * t;
      // Flashes the ray has now reached, seen through what lies in front.
      for (int f = 0; f < ${MAX_FLASHES}; f++) {
        if (!fDone[f] && t >= fT[f]) {
          fDone[f] = true;
          float g = uFlash[f].w * exp(-fD[f] * fD[f] * 6.0);
          col += T * g * vec3(1.6, 1.65, 1.9);
        }
      }
      vec3 uvw = tc(p);
      // Empty brick: jump to where the ray leaves it.
      vec3 bi = clamp(floor(uvw * uBricks), vec3(0.0), uBricks - 1.0);
      vec4 occ = texelFetch(uOcc, ivec3(bi), 0);
      if (occ.r < uSkip && (occ.g < 0.5 || uCone < 0.5)) {
        vec3 lo = bmin + bi * brick;
        vec2 bh = boxHit(p, rdSafe, lo, lo + brick);
        t += max(bh.y, 0.0) + uStep * 0.25;
        continue;
      }
      vec4 s = textureLod(uVol, uvw, uStyle == 0 ? uLod : 0.0);
      // The cone of silence (an option): a faint shell where seen meets unseen.
      float seen = occ.g > 0.5 ? textureLod(uVol, uvw, 2.2).b : 1.0;
      float unseen = (4.0 * seen * (1.0 - seen) * 0.1 + (1.0 - seen) * 0.003) * uCone;
      if (uStyle == 0) {
        float dbz, below;
        float den = stormDensity(s, p, dbz, below);
        float sigma = den * uDensity;
        if (sigma > 0.002) {
          float zr = p.z / uVScale;
          float hRel = clamp(zr / 12.0, 0.0, 1.0);
          float hail = smoothstep(54.0, 66.0, dbz);
          // Sunlight: the forward-lobed phase over a few octaves of
          // scattering, each reaching deeper into the cloud.
          float tau = sunTau(p, sd, uLod + 1.0, 6);
          float ms = 0.0;
          float oa = 1.0;
          float ob = 1.0;
          float ok = 1.0;
          for (int o = 0; o < 3; o++) {
            ms += oa * phase2(cosSun, ok) * exp(-ob * tau);
            oa *= 0.55;
            ob *= 0.35;
            ok *= 0.5;
          }
          // Powder: the sunlit skin of thick cloud is darker than its inside.
          float thick = textureLod(uVol, uvw, 2.5).g;
          float powder = 1.0 - 0.6 * thick * exp(-2.2 * tau) * (0.45 + 0.55 * away);
          // Sky light from above, blocked by the storm overhead; light bounced
          // off the sunlit ground from below, blocked by what is under.
          float aoUp = exp(-textureLod(uVol, tc(p + vec3(0.0, 0.0, 1.2 * uVScale)), 3.0).g * 1.5);
          float aoDn = exp(-textureLod(uVol, tc(p - vec3(0.0, 0.0, 1.0 * uVScale)), 3.0).g * 1.2);
          float lam = max(normalize(uSunDir).z, 0.0);
          vec3 amb = uAmbient * (0.35 + 0.65 * hRel) * (0.3 + 0.7 * aoUp);
          vec3 bounce = uSunColor * lam * 0.11 * aoDn * (1.0 - hRel) * vec3(0.85, 0.9, 0.8);
          vec3 light = uSunColor * ms * powder * 1.15 + amb + bounce;
          // Flashes light the cloud around them.
          vec3 flashLight = vec3(0.0);
          for (int f = 0; f < ${MAX_FLASHES}; f++) {
            if (f >= uFlashCount) break;
            vec3 dv = p - uFlash[f].xyz;
            dv.z /= uVScale;
            flashLight += uFlash[f].w * 4.0 / (1.0 + dot(dv, dv) / 8.0);
          }
          light += flashLight * vec3(0.75, 0.8, 1.0);
          // Rain under the base is grey and lets light through; hail is white.
          vec3 albedo = mix(vec3(0.97), mix(vec3(0.52, 0.56, 0.62), vec3(0.95, 0.97, 1.0), hail), below);
          vec3 emit = hail * (0.32 * (uAmbient + 0.22 * uSunColor) + vec3(0.03, 0.05, 0.07));
          float tr = exp(-sigma * uStep);
          col += T * (1.0 - tr) * (albedo * light + emit);
          T *= tr;
          if (T < 0.5 && tStop >= t1) tStop = t;
        }
      } else {
        float echo = s.g;
        if (echo > 0.004) {
          float v = clamp(s.r / echo, 0.0, 1.0);
          vec4 c = texture(uLut, vec2((1.0 + v * 253.0 + 0.5) / 256.0, 0.25));
          float sigma = c.a * echo * uOpacity;
          float tr = exp(-sigma * uStep);
          col += T * (1.0 - tr) * c.rgb;
          T *= tr;
        }
      }
      if (unseen > 0.01) {
        float tr = exp(-unseen * uStep);
        vec3 veil = uStyle == 0 ? (uAmbient * 0.9 + vec3(0.04)) : uGrid;
        col += T * (1.0 - tr) * veil;
        T *= tr;
      }
      t += uStep;
    }
  }

  // Flashes beyond where the march stopped.
  for (int f = 0; f < ${MAX_FLASHES}; f++) {
    if (!fDone[f] && fT[f] > 0.0) {
      float g = uFlash[f].w * exp(-fD[f] * fD[f] * 6.0);
      col += T * g * vec3(1.6, 1.65, 1.9);
    }
  }

  // Sunbeams: haze in the box lit where the storm does not shade it, up to
  // where the cloud hides what is behind.
  if (uStyle == 0 && uShafts > 0.5 && t1 > t0 && uSunDir.z > 0.0) {
    float te = min(tStop, t1);
    float dt = (te - t0) / 12.0;
    float sh = 0.0;
    for (int i = 0; i < 12; i++) {
      vec3 q = ro + rd * (t0 + (float(i) + jitter) * dt);
      sh += exp(-sunTau(q, sd, uLod + 2.0, 5));
    }
    float haze = 0.0016 * dt * hg(cosSun, 0.6);
    col += uSunColor * sh * haze;
  }

  if (T > 0.01) {
    bool inside = abs(gp.x) <= uBox.x && abs(gp.y) <= uBox.y;
    vec3 pic = vec3(0.0);
    if (gIn > 0.0) pic = textureGrad(uGroundTex, guv, gdx, gdy).rgb;
    if (tG < 1e8) {
      vec2 g = abs(fract(gp.xy / uGridKm + 0.5) - 0.5) * uGridKm;
      float grid = inside ? 1.0 - min(min(g.x / fw.x, g.y / fw.y), 1.0) : 0.0;
      float e = min(uBox.x - abs(gp.x), uBox.y - abs(gp.y));
      float edge = 1.0 - smoothstep(0.0, 1.5, abs(e) / max(fw.x, fw.y));
      float r = length(gp.xy - uRadar.xy);
      float ring = 1.0 - smoothstep(0.0, 1.5, abs(r - 1.2) / max(fw.x, fw.y));
      float dot0 = 1.0 - smoothstep(0.35, 0.35 + 1.5 * max(fw.x, fw.y), r);
      if (uStyle == 0) {
        vec3 albedo = mix(vec3(0.075, 0.09, 0.065), pow(pic, vec3(2.2)) * 0.95, gIn);
        float lam = max(normalize(uSunDir).z, 0.0);
        vec3 gcol = albedo * (uSunColor * lam * groundShadow(gp, sd) + uAmbient * 0.85);
        gcol = mix(gcol, gcol * 1.6 + 0.02, grid * mix(0.35, 0.1, gIn));
        gcol = mix(gcol, vec3(0.85) * (uAmbient + uSunColor * 0.3), edge * 0.45);
        gcol = mix(gcol, vec3(1.0, 0.95, 0.85), max(ring, dot0) * 0.8);
        float span = max(uBox.x, uBox.y);
        float fog = 1.0 - exp(-max(tG - span * 0.5, 0.0) / (span * 9.0));
        col += T * mix(gcol, uHorizon, fog);
      } else {
        vec3 under = inside ? uGround : uBg;
        vec3 gcol = mix(under, pic * 0.88, gIn * (inside ? 0.9 : 0.75));
        if (inside) gcol = mix(gcol, uGrid, max(grid * mix(0.55, 0.25, gIn), edge));
        gcol = mix(gcol, uGrid, max(ring, dot0) * (inside ? 1.0 : 0.0));
        col += T * gcol;
      }
    } else {
      col += T * (uStyle == 0 ? skyColor(rd) : uBg);
    }
  }

  if (uStyle == 0) {
    col = vec3(1.0) - exp(-col * uExposure);
    col = pow(col, vec3(1.0 / 2.2));
  }
  outColor = vec4(col, 1.0);
}`;

export const UPSCALE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uSharp;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  if (uSharp <= 0.0) { outColor = vec4(c, 1.0); return; }
  vec3 n = texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb;
  vec3 s = texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb;
  vec3 e = texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb;
  vec3 w = texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb;
  vec3 o = c + uSharp * (4.0 * c - n - s - e - w);
  // Clamp to the neighbourhood: sharp edges without halos.
  vec3 lo = min(c, min(min(n, s), min(e, w)));
  vec3 hi = max(c, max(max(n, s), max(e, w)));
  outColor = vec4(clamp(o, lo, hi), 1.0);
}`;

export const LINE_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

export const LINE_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec4 uColor;
void main() {
  outColor = uColor;
}`;
