import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { DepthOfFieldEffect } from 'postprocessing'
import { ToneMappingMode, Effect } from 'postprocessing'
import {
  EffectComposer, DepthOfField, Bloom, ToneMapping, Vignette, ChromaticAberration,
  Noise,
} from '@react-three/postprocessing'
import { folder, useControls } from 'leva'
import { hudUniforms } from '../diorama/buildDiorama'
import { PLANET_SPHERE } from './Interaction'

/**
 * DoF-ONLY debug build (branch: debug/dof-only).
 *
 * Everything else — exposure, SMAA, N8AO, SSAO, Bloom, Noise, Vignette,
 * RealismFX (SSGI/SSR/MotionBlur) — is stripped. Only DoF in the chain.
 *
 * If DoF STILL doesn't respond to focusDistance / focusRange with
 * everything else gone, the sphere composite pipeline (TileGrid's
 * gl_FragDepth rewrite into EffectComposer's RT) is corrupting DoF's
 * depth-texture input — the "only bokeh works" symptom is consistent
 * with CoC saturated at 1.0 everywhere (depth buffer stuck at far plane).
 */
/** Patch a CircleOfConfusionMaterial so its output CoC is
 *    magnitude = max(depthCoC, screenMask)
 *  and the near/far channel pair is blended toward (0, 1) by the same
 *  screenMask. screenMask = smoothstep(uSharpRadius, uBlurRadius, |vUv - uCursorUv|).
 *
 *  Two patches, one purpose. The magnitude override kills the focus RING
 *  (sharp pixels at the depth-focus circle of a convex surface). The
 *  near/far override kills the residual SEAM at that same circle where
 *  `step(signedDistance, 0.0)` flips sign — downstream DoF blurs near and
 *  far fields with different kernels, so a flip at CoC=1 shows as a
 *  "distorting" band even when magnitudes match. Locking the classification
 *  toward far-only as screenMask saturates removes the flip.
 *
 *  Idempotent — the __cocPatched guard prevents duplicate uniform
 *  declarations when the wrapper re-instantiates the effect.
 */
/** Combined saturation + brightness + contrast effect with bilateral clamps
 *  and gamma-style contrast.
 *
 *  Replaces postprocessing's `HueSaturationEffect` + `BrightnessContrastEffect`.
 *  Both libs' shaders use only an upper `min(color, 1.0)` clamp; the lower
 *  end can go NEGATIVE on HDR float framebuffers. HueSat pushes channels
 *  below zero when saturating; BC's midgray-pivoted contrast then stretches
 *  them further negative and/or crushes dark pixels to exactly zero. The
 *  negatives propagate through Vignette (× scalar), CA (sample + mix), and
 *  final display clamp → solid-black pixels in regions that should be dark
 *  tinted.
 *
 *  This effect fixes both with:
 *    1. Luminance-mix saturation (no per-channel extrapolation against
 *       an RGB-average).
 *    2. Gamma-style contrast (`pow(c, gamma)`), which is monotone on [0,1],
 *       never produces negatives, and doesn't crush shadows to zero.
 *    3. `clamp(c, 0, 1)` at each stage + final, so even if upstream
 *       Bloom/ToneMap hands us out-of-range values, we can't pollute the
 *       downstream buffer.
 *
 *  Contrast mapping: `gamma = (contrast >= 0 ? 1 + contrast : 1 / (1 - contrast))`
 *  → contrast=0 → gamma=1 (identity). contrast=0.5 → gamma=1.5 (darker shadows,
 *  preserved highlights, no shadow crush). contrast=-0.5 → gamma≈0.667 (lifted
 *  shadows).
 */
const SAFE_GRADE_FRAG = `
uniform float saturation;
uniform float brightness;
uniform float contrast;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);
  float gray = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(mix(vec3(gray), c, 1.0 + saturation), 0.0, 1.0);
  c = clamp(c + vec3(brightness), 0.0, 1.0);
  float gamma = contrast >= 0.0 ? (1.0 + contrast) : (1.0 / (1.0 - contrast));
  c = pow(c, vec3(gamma));
  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`
class SafeColorGradeEffect extends Effect {
  constructor(saturation = 0, brightness = 0, contrast = 0) {
    super('SafeColorGradeEffect', SAFE_GRADE_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ['saturation', new THREE.Uniform(saturation)],
        ['brightness', new THREE.Uniform(brightness)],
        ['contrast',   new THREE.Uniform(contrast)],
      ]),
    })
  }
  get saturation(): number { return (this.uniforms.get('saturation') as THREE.Uniform).value as number }
  set saturation(v: number) { (this.uniforms.get('saturation') as THREE.Uniform).value = v }
  get brightness(): number { return (this.uniforms.get('brightness') as THREE.Uniform).value as number }
  set brightness(v: number) { (this.uniforms.get('brightness') as THREE.Uniform).value = v }
  get contrast(): number { return (this.uniforms.get('contrast') as THREE.Uniform).value as number }
  set contrast(v: number) { (this.uniforms.get('contrast') as THREE.Uniform).value = v }
}

function patchCocMaterial(mat: THREE.ShaderMaterial): void {
  const ud = mat.userData as { __cocPatched?: boolean }
  if (ud.__cocPatched) return
  ud.__cocPatched = true

  mat.uniforms.uCursorUv    = { value: new THREE.Vector2(0.5, 0.5) }
  mat.uniforms.uSharpRadius = { value: 0.08 }
  mat.uniforms.uBlurRadius  = { value: 0.30 }
  mat.uniforms.uAspect      = { value: 1 }

  let frag = mat.fragmentShader
  frag = frag.replace(
    'void main()',
    'uniform vec2 uCursorUv; uniform float uSharpRadius; uniform float uBlurRadius; uniform float uAspect; void main()'
  )
  frag = frag.replace(
    'float magnitude=smoothstep(0.0,focusRange,abs(signedDistance));',
    'float _dd=smoothstep(0.0,focusRange,abs(signedDistance));' +
    'vec2 _du=vec2((vUv.x-uCursorUv.x)*uAspect, vUv.y-uCursorUv.y);' +
    'float _sm=smoothstep(uSharpRadius, uBlurRadius, length(_du));' +
    'float magnitude=max(_dd, _sm);'
  )
  frag = frag.replace(
    'gl_FragColor.rg=magnitude*vec2(step(signedDistance,0.0),step(0.0,signedDistance));',
    'float _nf=mix(step(signedDistance,0.0), 0.0, _sm);' +
    'float _ff=mix(step(0.0,signedDistance), 1.0, _sm);' +
    'gl_FragColor.rg=magnitude*vec2(_nf,_ff);'
  )
  mat.fragmentShader = frag
  mat.needsUpdate = true
}

export function PostFx() {
  const { camera, gl, size } = useThree()
  const {
    dofEnabled, dofFollowCursor, dofFocusRangeOnCursor, dofFocusRangeWholePlanet,
    dofBokehScale, dofSmoothing, dofDebugTarget, dofFocusSurfaceRadius,
    dofScreenSharpRadius, dofScreenBlurRadius, dofResolutionScale,
    dofDebugFixedDistance, dofDebugFixedValue,
    toneExposure,
    bloomEnabled, bloomIntensity, bloomThreshold, bloomSmoothing,
    vignetteEnabled, vignetteOffset, vignetteDarkness,
    caEnabled, caOffsetX, caOffsetY, caRadialMask, caRadialOffset,
    gradeEnabled, gradeSaturation, gradeContrast, gradeBrightness,
    noiseEnabled, noiseOpacity,
  } = useControls('PostFx', {
    'Depth of Field': folder({
      dofEnabled: { value: true, label: 'on' },
      dofFollowCursor: { value: true, label: 'follow cursor (else planet)' },
      dofFocusRangeOnCursor: { value: 1.0, min: 0.05, max: 25, step: 0.05, label: 'range on hover (m)' },
      dofFocusRangeWholePlanet: { value: 20.0, min: 1, max: 150, step: 0.5, label: 'range full planet (m)' },
      dofBokehScale: { value: 4.0, min: 0, max: 40, step: 0.1, label: 'bokeh' },
      dofSmoothing: { value: 0.18, min: 0.01, max: 1, step: 0.01, label: 'follow speed' },
      dofFocusSurfaceRadius: { value: 1.05, min: 1.0, max: 1.30, step: 0.005, label: 'focus surface R' },
      // Bokeh render-target downscale. This is the library's real cost knob
      // for DoF (tap counts are hardcoded at 64+16). 0.5 default ≈ 4× cheaper
      // than 1.0 full-res. Pushed via `resolution.scale` runtime setter so
      // the effect isn't reinstantiated on every slider tick.
      dofResolutionScale: { value: 0.35, min: 0.25, max: 1.0, step: 0.05, label: 'bokeh res scale' },
      // Screen-space aperture. CoC shader is patched to
      //   magnitude = max(depthCoC, smoothstep(sharpR, blurR, screenDist))
      // so a tack-sharp *circle* appears around the projected dofTarget, and
      // the depth-focus ring beyond the circle becomes invisible (CoC=1).
      // Radii are in UV-height units: 0.1 ≈ 10% of the shorter screen axis.
      dofScreenSharpRadius: { value: 0.08, min: 0.0, max: 1.0, step: 0.005, label: 'screen sharp R' },
      dofScreenBlurRadius:  { value: 0.30, min: 0.01, max: 1.5, step: 0.01, label: 'screen blur R' },
      dofDebugTarget: { value: false, label: 'debug: show target' },
      dofDebugFixedDistance: { value: false, label: 'debug: fixed distance' },
      dofDebugFixedValue: { value: 3.5, min: 0.1, max: 30, step: 0.05, label: 'debug: distance value' },
    }, { collapsed: false }),
    // Renderer-level exposure. ACES lives in the ToneMapping effect below;
    // gl.toneMappingExposure flows into three.js's built-in ACES function
    // via the standard toneMappingExposure uniform even though
    // gl.toneMapping is forced to NoToneMapping by the composer wrapper.
    'Tone Mapping': folder({
      toneExposure: { value: 1.0, min: 0.1, max: 3.0, step: 0.01, label: 'exposure' },
    }, { collapsed: true }),
    'Bloom': folder({
      bloomEnabled: { value: true, label: 'on' },
      bloomIntensity: { value: 0.6, min: 0, max: 4, step: 0.05, label: 'intensity' },
      bloomThreshold: { value: 0.9, min: 0, max: 1.5, step: 0.01, label: 'luminance threshold' },
      bloomSmoothing: { value: 0.2, min: 0, max: 1, step: 0.01, label: 'smoothing' },
    }, { collapsed: true }),
    'Vignette': folder({
      vignetteEnabled: { value: true, label: 'on' },
      vignetteOffset: { value: 0.5, min: 0, max: 1, step: 0.01, label: 'offset' },
      vignetteDarkness: { value: 1.0, min: 0, max: 2, step: 0.01, label: 'darkness' },
    }, { collapsed: true }),
    'Chromatic Aberration': folder({
      caEnabled: { value: true, label: 'on' },
      caOffsetX: { value: 0.0015, min: 0, max: 0.01, step: 0.0001, label: 'offset x' },
      caOffsetY: { value: 0.0015, min: 0, max: 0.01, step: 0.0001, label: 'offset y' },
      // Built-in vignette-style mask on the CA effect itself:
      //   d = max(distance(uv, center)*2 - modulationOffset, 0)
      // → zero CA inside a centered disc of radius `radialOffset`, ramping
      //   to full CA at the corners. Does not require a separate mask pass.
      caRadialMask: { value: true, label: 'edges only (radial mask)' },
      caRadialOffset: { value: 0.35, min: 0, max: 1, step: 0.01, label: 'mask inner radius' },
    }, { collapsed: true }),
    // Tiny-world / miniature grade. HueSaturation + BrightnessContrast sit
    // after tone mapping (LDR) so the grade operates on display-ready values.
    'Color Grade': folder({
      gradeEnabled: { value: true, label: 'on' },
      gradeSaturation: { value: 0.25, min: -1, max: 1, step: 0.01, label: 'saturation' },
      gradeContrast:   { value: 0.15, min: -1, max: 1, step: 0.01, label: 'contrast' },
      gradeBrightness: { value: 0.0,  min: -1, max: 1, step: 0.01, label: 'brightness' },
    }, { collapsed: false }),
    'Grain': folder({
      noiseEnabled: { value: true, label: 'on' },
      noiseOpacity: { value: 0.035, min: 0, max: 0.3, step: 0.005, label: 'opacity' },
    }, { collapsed: true }),
  })

  // Cursor raycast sphere radius — sync from Leva.
  useEffect(() => {
    PLANET_SPHERE.radius = dofFocusSurfaceRadius
  }, [dofFocusSurfaceRadius])

  // Drive the DoF bokeh-buffer resolution at runtime. `resolution.scale` has
  // a real setter (dispatches 'change' → setSize); we deliberately DO NOT
  // pass `resolutionScale` as a wrapper prop because @react-three/postprocessing
  // useMemos the effect on its full prop list — a slider-changed prop would
  // reinstantiate the effect every tick (P4: ref props lost, cocMaterial
  // re-patched via lastPatchedMat each time).
  useEffect(() => {
    const e = dofRef.current
    if (!e) return
    e.resolution.scale = dofResolutionScale
  }, [dofResolutionScale])

  // Tone-mapping exposure. `@react-three/postprocessing` forces
  // gl.toneMapping = NoToneMapping on mount so ACES runs via the
  // ToneMapping effect instead of the renderer. But it does NOT touch
  // gl.toneMappingExposure, and three.js's built-in ACESFilmicToneMapping
  // function (which postprocessing's ACES mode compiles to via
  // `#define toneMapping(texel) ACESFilmicToneMapping(texel)`) reads the
  // standard `toneMappingExposure` uniform — still wired to the renderer
  // property. So writing gl.toneMappingExposure is the correct handle.
  useEffect(() => {
    gl.toneMappingExposure = toneExposure
  }, [gl, toneExposure])

  // CA offset as a Vector2 — postprocessing's effect constructor expects one.
  const caOffset = useMemo(() => new THREE.Vector2(caOffsetX, caOffsetY), [caOffsetX, caOffsetY])

  // Combined saturation + brightness + contrast — one instance, uniform driven.
  const gradeEffect = useMemo(
    () => new SafeColorGradeEffect(gradeSaturation, gradeBrightness, gradeContrast),
    [],
  )
  useEffect(() => {
    gradeEffect.saturation = gradeSaturation
    gradeEffect.brightness = gradeBrightness
    gradeEffect.contrast   = gradeContrast
  }, [gradeEffect, gradeSaturation, gradeBrightness, gradeContrast])
  useEffect(() => () => gradeEffect.dispose(), [gradeEffect])

  const dofRef = useRef<DepthOfFieldEffect | null>(null)
  const dofTarget = useMemo(() => new THREE.Vector3(), [])
  const dofDesired = useMemo(() => new THREE.Vector3(), [])
  const [cursorActive, setCursorActive] = useState(false)
  const activeRange = cursorActive ? dofFocusRangeOnCursor : dofFocusRangeWholePlanet
  const debugMeshRef = useRef<THREE.Mesh | null>(null)

  const lastPatchedMat = useRef<THREE.ShaderMaterial | null>(null)
  const tmpNdc = useMemo(() => new THREE.Vector3(), [])

  // Force-wire DoF's depth source to sphereTarget.depthTexture each frame.
  // This overrides whatever EffectComposer wired (empty/far-plane) with the
  // actual populated planet depth from TileGrid's offscreen FBO. Both
  // sphereTarget.depthTexture and EffectComposer's RT use the same camera
  // near/far, so the CoC shader's viewPosition reconstruction is valid.
  //
  // Also patches cocMaterial on each (re-)instantiation so the CoC output
  // gets a screen-space aperture mask (sharp circle around the projected
  // dofTarget), and writes its uniforms each frame.
  useFrame(() => {
    const e = dofRef.current
    if (!e) return
    const depth = hudUniforms.uSphereDepth.value
    if (depth) e.setDepthTexture(depth)

    // Patch on first observation and every time the wrapper re-instantiates
    // the effect (new cocMaterial ref).
    const mat = e.cocMaterial as THREE.ShaderMaterial
    if (mat && lastPatchedMat.current !== mat) {
      patchCocMaterial(mat)
      lastPatchedMat.current = mat
    }

    // Project dofTarget world → NDC → UV. Using the eased target (not the
    // raw cursor) keeps the aperture smooth. Off-planet: target is the
    // front pole → aperture centers on the visible center of the planet.
    if (mat?.userData && (mat.userData as { __cocPatched?: boolean }).__cocPatched) {
      tmpNdc.copy(dofTarget).project(camera)
      const u = mat.uniforms
      ;(u.uCursorUv.value as THREE.Vector2).set(tmpNdc.x * 0.5 + 0.5, tmpNdc.y * 0.5 + 0.5)
      u.uSharpRadius.value = dofScreenSharpRadius
      u.uBlurRadius.value = dofScreenBlurRadius
      // Aspect keeps the mask a true screen-space circle, not UV-stretched.
      u.uAspect.value = size.width / size.height
    }
  })

  useLayoutEffect(() => {
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__dofTarget = dofTarget
    }
  }, [dofTarget])

  useFrame(() => {
    if (!dofEnabled || !dofRef.current) return

    // Attach target unless we're in fixed-distance debug mode.
    const wantTarget = !dofDebugFixedDistance
    if (wantTarget && dofRef.current.target !== dofTarget) {
      dofRef.current.target = dofTarget
    } else if (!wantTarget && dofRef.current.target !== null) {
      dofRef.current.target = null
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__dofEffect = dofRef.current
    }

    const active = hudUniforms.uHudCursorActive.value > 0 && dofFollowCursor
    if (active !== cursorActive) setCursorActive(active)
    if (active) {
      dofDesired.copy(hudUniforms.uHudCursor.value)
    } else {
      // Off-planet: aim at the FRONT POLE (closest point of the planet to
      // the camera), NOT the origin. camera→origin passes through the back
      // of the planet; focusing at origin-depth puts the focal plane at the
      // planet's silhouette ring (equator as camera sees it) and defocuses
      // the visible center. Front pole = origin + normalize(camera) * R,
      // which gives focus depth = cameraDistance − R → the closest visible
      // surface. Combined with the wide rangeWholePlanet (~20m), the whole
      // planet falls inside the focus slab.
      dofDesired.copy(camera.position).normalize().multiplyScalar(dofFocusSurfaceRadius)
    }
    const ease = Math.min(1, dofSmoothing)
    dofTarget.lerp(dofDesired, ease)
    if (debugMeshRef.current) debugMeshRef.current.position.copy(dofTarget)
  })

  return (
    <>
      {dofEnabled && dofDebugTarget ? (
        <mesh ref={debugMeshRef} renderOrder={9999}>
          <sphereGeometry args={[0.05, 16, 16]} />
          <meshBasicMaterial color="#ff00ff" depthTest={false} depthWrite={false} />
        </mesh>
      ) : null}
      <EffectComposer multisampling={0}>
        {dofEnabled ? (
          <DepthOfField
            ref={dofRef}
            bokehScale={dofBokehScale}
            focusRange={activeRange}
            {...(dofDebugFixedDistance ? { focusDistance: dofDebugFixedValue } : {})}
          />
        ) : <></>}
        {bloomEnabled ? (
          <Bloom
            intensity={bloomIntensity}
            luminanceThreshold={bloomThreshold}
            luminanceSmoothing={bloomSmoothing}
            mipmapBlur
          />
        ) : <></>}
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        {gradeEnabled ? (
          <primitive object={gradeEffect} />
        ) : <></>}
        {vignetteEnabled ? (
          <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />
        ) : <></>}
        {caEnabled ? (
          <ChromaticAberration
            offset={caOffset}
            radialModulation={caRadialMask}
            modulationOffset={caRadialOffset}
          />
        ) : <></>}
        {noiseEnabled ? (
          <Noise opacity={noiseOpacity} premultiply />
        ) : <></>}
      </EffectComposer>
    </>
  )
}
