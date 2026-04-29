/**
 * Flow-shader GLSL chunks.
 *
 * Vertex pass declares the extra UV1/UV2/color attributes the
 * CellFluids 2 export (and any compatible mesh) carries, and emits
 * varyings + world position for the fragment.
 *
 * Fragment pass implements the Valve-style flowmap blend (sample
 * tileable noise twice along the flow direction at offset phases,
 * cross-fade with a triangle wave so motion never visibly resets) and
 * a stylized cel-shaded colour bake (shallow / mid / deep gradient
 * driven by `color.g`, foam from `color.r` plus wave-crest detection).
 *
 * The flow direction can come from any of:
 *   - per-vertex `uv1` (uFlowSource = 1)
 *   - per-vertex `uv2` (uFlowSource = 2)
 *   - a uniform vector (when length(uUniformFlow) > 0; ground planes
 *     and any geometry without per-vertex flow data use this)
 *   - sampled from a flow-map texture at uv0 (when uFlowMapEnabled = 1)
 *
 * Direction-fix knobs (uFlowSign per axis, uFlowSwapXY, uFlowRemap)
 * cover the 16-permutation matrix of channel × sign × swap × remap so
 * any export convention can be matched without recompiling.
 */

export const FLOW_VERT = /* glsl */`
  attribute vec2 uv1;
  attribute vec2 uv2;
  varying vec3 vNormalW;
  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec2 vUv2;
  varying vec4 vColor0;
  void main() {
    vUv0 = uv;
    vUv1 = uv1;
    vUv2 = uv2;
    vColor0 = color;
    vNormalW = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const FLOW_FRAG = /* glsl */`
  precision highp float;
  uniform int   uMode;        // 0 flow, 1 shaded, 2 color0, 3 uv0,
                              // 4 uv1, 5 uv2, 6 flowDir
  uniform float uTime;

  // Flow shader knobs
  uniform float uFlowSpeed;
  uniform float uNoiseScale;
  uniform int   uFlowSource;       // 1 = uv1, 2 = uv2
  uniform float uFlowRemap;        // 0 = raw, 1 = (x*2-1)
  uniform float uFlowStrength;
  uniform vec2  uFlowSign;         // -1 / 1 per axis
  uniform float uFlowSwapXY;       // 0 / 1
  uniform vec2  uUniformFlow;      // override: non-zero takes priority

  // Optional flow-map texture sampling (e.g. baked PNG from any
  // CellFluids mesh, applied to a generic plane). uFlowMapEnabled = 1
  // routes flow through the texture path instead of vertex attributes.
  uniform int       uFlowMapEnabled;
  uniform sampler2D uFlowMap;
  uniform vec2      uFlowMapUvScale;
  uniform vec2      uFlowMapUvOffset;

  uniform float uFoamThreshold;
  uniform float uFoamSoftness;
  uniform float uColorBands;
  uniform vec3  uShallowColor;
  uniform vec3  uMidColor;
  uniform vec3  uDeepColor;
  uniform vec3  uFoamColor;
  uniform float uDepthInfluence;
  uniform float uHighlightStrength;
  uniform vec3  uLightDir;

  varying vec3 vNormalW;
  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec2 vUv2;
  varying vec4 vColor0;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float waterNoise(vec2 p) {
    float n = 0.0;
    n += 0.55 * vnoise(p);
    n += 0.30 * vnoise(p * 2.31 + vec2(7.3, 1.7));
    n += 0.15 * vnoise(p * 5.07 + vec2(2.1, 9.4));
    return n;
  }
  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }

  void main() {
    if (uMode == 1) {
      vec3 L = normalize(vec3(0.4, 0.7, 0.2));
      float ndl = max(dot(vNormalW, L), 0.0);
      float hemi = 0.5 + 0.5 * vNormalW.y;
      gl_FragColor = vec4(vec3(0.55, 0.75, 0.95) * (0.4 * hemi + 0.7 * ndl), 1.0);
      return;
    }
    if (uMode == 2) { gl_FragColor = vec4(vColor0.rgb, 1.0); return; }
    if (uMode == 3) { gl_FragColor = vec4(vUv0, 0.0, 1.0); return; }
    if (uMode == 4) { gl_FragColor = vec4(vUv1, 0.0, 1.0); return; }
    if (uMode == 5) { gl_FragColor = vec4(vUv2, 0.0, 1.0); return; }
    if (uMode == 6) {
      vec2 raw = uFlowSource == 1 ? vUv1 : vUv2;
      vec2 dir = mix(raw, raw * 2.0 - 1.0, uFlowRemap);
      dir = mix(dir, dir.yx, uFlowSwapXY) * uFlowSign;
      float mag = clamp(length(dir), 0.0, 1.0);
      float ang = atan(dir.y, dir.x) / 6.28318 + 0.5;
      gl_FragColor = vec4(hsv2rgb(vec3(ang, 1.0, mag)), 1.0);
      return;
    }

    vec2 flowDir;
    if (uFlowMapEnabled == 1) {
      vec2 sampleUv = vUv0 * uFlowMapUvScale + uFlowMapUvOffset;
      vec4 fm = texture2D(uFlowMap, sampleUv);
      flowDir = (fm.rg * 2.0 - 1.0) * uFlowStrength;
    } else if (length(uUniformFlow) > 1e-4) {
      flowDir = uUniformFlow * uFlowStrength;
    } else {
      vec2 raw = uFlowSource == 1 ? vUv1 : vUv2;
      flowDir = mix(raw, raw * 2.0 - 1.0, uFlowRemap);
      flowDir = mix(flowDir, flowDir.yx, uFlowSwapXY) * uFlowSign * uFlowStrength;
    }

    float t = uTime * uFlowSpeed;
    float phaseA = fract(t);
    float phaseB = fract(t + 0.5);
    float w = abs(phaseA * 2.0 - 1.0);

    vec2 baseUv = vUv0 * uNoiseScale;
    vec2 uvA = baseUv - flowDir * phaseA;
    vec2 uvB = baseUv - flowDir * phaseB + vec2(0.37, 0.71);
    float nA = waterNoise(uvA);
    float nB = waterNoise(uvB);
    float n = mix(nA, nB, w);

    float bandSoft = mix(0.18, 0.02, uColorBands);
    float bands = smoothstep(0.5 - bandSoft, 0.5 + bandSoft, n);

    float depth = mix(0.5, vColor0.g, uDepthInfluence);
    vec3 baseCol = mix(uShallowColor, uDeepColor, smoothstep(0.0, 1.0, depth));
    baseCol = mix(baseCol, uMidColor, bands * 0.45);

    float crestFoam = smoothstep(0.7, 0.95, n) * (1.0 - depth);
    float foamMask = clamp(vColor0.r + crestFoam * 0.6, 0.0, 1.0);
    float foam = smoothstep(uFoamThreshold - uFoamSoftness, uFoamThreshold + uFoamSoftness, foamMask);
    vec3 col = mix(baseCol, uFoamColor, foam);

    vec3 L = normalize(uLightDir);
    float ndl = max(dot(vNormalW, L), 0.0) * uHighlightStrength + (1.0 - uHighlightStrength);
    col *= ndl;

    float spark = smoothstep(0.85, 1.0, n) * (1.0 - depth);
    col += vec3(spark) * 0.25;

    gl_FragColor = vec4(col, 1.0);
  }
`
