import * as THREE from 'three';
import { GLSL_COMMON, type SharedUniforms } from './uniforms';
import { getTheme, type Theme } from './themes';

/**
 * Colour that ground and walls drift toward once the ghost has walked away and
 * only the memory of a corridor is left.
 */
function glslMemoryTint(theme: Theme): string {
  const [r, g, b] = theme.memoryTint;
  return `const vec3 MEMORY_TINT = vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)});`;
}

/**
 * Ground that remembers every ghost: scorch marks glowing in the seams, frost
 * creeping over the surface, and melt ponds that mirror the lamp. The theme
 * supplies the surface itself - cobbles, lawn or wet asphalt.
 */
export function createFloorMaterial(
  shared: SharedUniforms,
  theme: Theme = getTheme(null)
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: shared as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      ${glslMemoryTint(theme)}
      ${theme.floorGlsl}
      varying vec3 vWorldPos;

      void main() {
        vec2 world = vWorldPos.xz;
        vec4 field = sampleField(world);

        // --- themed ground ------------------------------------------------
        float crack;
        vec3 emissive;
        vec3 surface = themeFloor(world, crack, emissive);
        vec3 normal = vec3(0.0, 1.0, 0.0);

        vec3 col = surface * uAmbient * 3.4;
        col += surface * ghostLights(vWorldPos, normal);
        col += emissive;

        // --- melt ponds ---------------------------------------------------
        float water = smoothstep(0.28, 0.72, field.b);
        if (water > 0.001) {
          float ripple = 0.5 + 0.5 * sin(length(world * 3.1) * 7.0 - uTime * 2.3 + valueNoise(world * 5.0) * 6.0);
          vec3 waterCol = mix(WATER_DEEP, WATER_SHINE, ripple);
          vec3 wobble = normalize(vec3(
            (valueNoise(world * 4.0 + uTime * 0.35) - 0.5) * 0.55,
            1.0,
            (valueNoise(world * 4.0 - uTime * 0.31) - 0.5) * 0.55
          ));
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          vec3 lampDir = normalize(uLampPos - vWorldPos);
          vec3 wispDir = normalize(uWispPos - vWorldPos);
          float lampAtt = clamp(1.0 - length(uLampPos - vWorldPos) / uLampRange, 0.0, 1.0);
          float wispAtt = clamp(1.0 - length(uWispPos - vWorldPos) / uWispRange, 0.0, 1.0);
          float lampSpec = pow(max(dot(normalize(lampDir + viewDir), wobble), 0.0), 48.0) * lampAtt * 2.6;
          float wispSpec = pow(max(dot(normalize(wispDir + viewDir), wobble), 0.0), 60.0) * wispAtt * 1.8;
          vec3 spec = uLampColor * lampSpec + uWispColor * wispSpec;
          col = mix(col, waterCol + spec, water);
          crack = mix(crack, 0.15, water);
        }

        // --- heat & frost trails -----------------------------------------
        col += trailGlow(field, crack, world);

        // --- what the ghost can actually see ------------------------------
        float light = field.a;
        // Unseen ground keeps a readable floor instead of dropping to black:
        // the contrast with lit tiles is what sells the fog, not pure darkness.
        float seen = max(light, 0.26);
        col *= seen;
        // remembered-but-unseen ground drifts toward the theme's night colour
        col = mix(col * MEMORY_TINT, col, smoothstep(0.0, 0.55, light));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Maze walls: brick, hedge or lit facade, depending on the theme. */
export function createWallMaterial(
  shared: SharedUniforms,
  theme: Theme = getTheme(null)
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: shared as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec3 vViewPos;
      void main() {
        vec4 wp = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * wp;
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      ${glslMemoryTint(theme)}
      ${theme.wallGlsl}
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec3 vViewPos;

      void main() {
        // Dissolve the walls that stand between the camera and the ghost. Only
        // a tight window around the ghost clears completely; the rest of the
        // wall stays up so the maze still reads as solid.
        vec3 focusView = (viewMatrix * vec4(uFocus, 1.0)).xyz;
        float depthDelta = vViewPos.z - focusView.z;
        if (depthDelta > 0.25) {
          float r = length(vViewPos.xy - focusView.xy);
          float fade = (1.0 - smoothstep(uFadeRadius * 0.62, uFadeRadius, r))
            * smoothstep(0.25, 0.9, depthDelta);
          if (fade > bayer(gl_FragCoord.xy)) discard;
        }

        vec3 n = normalize(vNormalW);
        bool isTop = n.y > 0.5;

        // Sample the trail field in the corridor this face looks into.
        vec2 probe = vWorldPos.xz + n.xz * 1.9;
        vec4 field = isTop ? vec4(0.0) : sampleField(probe);
        if (isTop) {
          vec4 a = sampleField(vWorldPos.xz + vec2(1.9, 0.0));
          vec4 b = sampleField(vWorldPos.xz + vec2(-1.9, 0.0));
          vec4 c = sampleField(vWorldPos.xz + vec2(0.0, 1.9));
          vec4 e = sampleField(vWorldPos.xz + vec2(0.0, -1.9));
          field = max(max(a, b), max(c, e)) * vec4(0.45, 0.45, 0.0, 0.85);
        }

        // Glow hugs the base of the wall and fades upward.
        float heightFade = exp(-max(vWorldPos.y, 0.0) * 1.15);
        field.rg *= isTop ? 0.35 : heightFade;

        // --- themed wall face ---------------------------------------------
        vec2 uv = abs(n.x) > 0.5 ? vec2(vWorldPos.z, vWorldPos.y) : vec2(vWorldPos.x, vWorldPos.y);
        float mask;
        vec3 emissive;
        vec3 surface = themeWall(uv, vWorldPos, n, isTop, mask, emissive);

        vec3 col = surface * uAmbient * 3.4;
        col += surface * ghostLights(vWorldPos, n);
        col += trailGlow(field, mask, vWorldPos.xz);

        float light = field.a;
        col *= max(light, 0.24);
        col = mix(col * MEMORY_TINT, col, smoothstep(0.0, 0.55, light));
        // Lit windows and signs are scenery rather than information about the
        // ghosts, so they keep a little glow in the dark - but only a little,
        // or the fog of war would stop hiding anything.
        col += emissive * mix(0.3, 1.0, smoothstep(0.0, 0.6, light));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
