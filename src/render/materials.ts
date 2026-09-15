import * as THREE from 'three';
import { GLSL_COMMON, type SharedUniforms } from './uniforms';

/**
 * Wet cobblestones that remember every ghost: scorch marks glowing in the
 * mortar, frost creeping over the stones, and melt ponds that mirror the lamp.
 */
export function createFloorMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
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
      varying vec3 vWorldPos;

      void main() {
        vec2 world = vWorldPos.xz;
        vec4 field = sampleField(world);

        // --- cobblestones -------------------------------------------------
        vec2 p = world * 1.45;
        p.x += 0.5 * mod(floor(p.y), 2.0);
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float d = max(abs(f.x) * 1.02, abs(f.y) * 1.22);
        float crack = smoothstep(0.34, 0.5, d);
        float tone = 0.72 + 0.4 * hash21(cell);
        float grain = 0.9 + 0.1 * valueNoise(world * 5.0);

        vec3 stone = mix(vec3(0.088, 0.081, 0.073) * tone * grain, vec3(0.014, 0.014, 0.018), crack);
        vec3 normal = vec3(0.0, 1.0, 0.0);

        vec3 col = stone * uAmbient * 3.0;
        col += stone * ghostLights(vWorldPos, normal);

        // --- melt ponds ---------------------------------------------------
        float water = smoothstep(0.28, 0.72, field.b);
        if (water > 0.001) {
          float ripple = 0.5 + 0.5 * sin(length(world * 3.1) * 7.0 - uTime * 2.3 + valueNoise(world * 5.0) * 6.0);
          vec3 waterCol = mix(vec3(0.014, 0.03, 0.055), vec3(0.03, 0.07, 0.12), ripple);
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
        float seen = max(light, 0.18);
        col *= seen;
        // remembered-but-unseen ground drifts toward cold moonlight
        col = mix(col * vec3(0.55, 0.62, 0.95), col, smoothstep(0.0, 0.55, light));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Alley walls: brickwork that scorches red where the lantern passed by. */
export function createWallMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
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
      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying vec3 vViewPos;

      void main() {
        // Dissolve walls that stand between the camera and the ghost.
        // Dissolve the walls that stand between the camera and the ghost. Walls
        // directly in front must clear completely, not just thin out.
        vec3 focusView = (viewMatrix * vec4(uFocus, 1.0)).xyz;
        float depthDelta = vViewPos.z - focusView.z;
        if (depthDelta > 0.25) {
          float r = length(vViewPos.xy - focusView.xy);
          float fade = (1.0 - smoothstep(uFadeRadius * 0.8, uFadeRadius * 1.08, r))
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

        // --- brickwork ----------------------------------------------------
        vec2 uv = abs(n.x) > 0.5 ? vec2(vWorldPos.z, vWorldPos.y) : vec2(vWorldPos.x, vWorldPos.y);
        vec2 b = uv * vec2(1.7, 2.6);
        b.x += 0.5 * mod(floor(b.y), 2.0);
        vec2 bc = floor(b);
        vec2 bf = fract(b) - 0.5;
        float bd = max(abs(bf.x) * 1.0, abs(bf.y) * 1.35);
        float mortar = smoothstep(0.36, 0.49, bd);
        float tone = 0.68 + 0.42 * hash21(bc + 17.0);
        float grime = 0.8 + 0.2 * valueNoise(uv * 7.0);

        vec3 brick = mix(vec3(0.075, 0.066, 0.058) * tone * grime, vec3(0.016, 0.015, 0.018), mortar);
        if (isTop) brick *= 0.55;

        vec3 col = brick * uAmbient * 3.0;
        col += brick * ghostLights(vWorldPos, n);
        col += trailGlow(field, mortar, vWorldPos.xz);

        float light = field.a;
        col *= max(light, 0.16);
        col = mix(col * vec3(0.5, 0.58, 0.95), col, smoothstep(0.0, 0.55, light));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
