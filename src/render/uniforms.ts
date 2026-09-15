import * as THREE from 'three';

/**
 * Uniforms shared by the floor and wall materials. Both need the trail field,
 * the two ghost lights and the camera focus used for the see-through-walls
 * dither, so they are created once and handed to every material.
 */
export interface SharedUniforms {
  uTime: { value: number };
  uField: { value: THREE.DataTexture };
  uGridOrigin: { value: THREE.Vector2 };
  uGridSize: { value: THREE.Vector2 };
  uFocus: { value: THREE.Vector3 };
  uFadeRadius: { value: number };
  uLampPos: { value: THREE.Vector3 };
  uLampColor: { value: THREE.Color };
  uLampPower: { value: number };
  uLampRange: { value: number };
  uWispPos: { value: THREE.Vector3 };
  uWispColor: { value: THREE.Color };
  uWispPower: { value: number };
  uWispRange: { value: number };
  uAmbient: { value: THREE.Color };
}

export function createSharedUniforms(field: THREE.DataTexture): SharedUniforms {
  return {
    uTime: { value: 0 },
    uField: { value: field },
    uGridOrigin: { value: new THREE.Vector2() },
    uGridSize: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: new THREE.Vector3() },
    uFadeRadius: { value: 1.9 },
    uLampPos: { value: new THREE.Vector3(0, 1, 0) },
    uLampColor: { value: new THREE.Color(0xffb257) },
    uLampPower: { value: 1.6 },
    uLampRange: { value: 28 },
    uWispPos: { value: new THREE.Vector3(0, 1, 0) },
    uWispColor: { value: new THREE.Color(0x6fd8ff) },
    uWispPower: { value: 1.6 },
    uWispRange: { value: 23 },
    uAmbient: { value: new THREE.Color(0x3a4673) },
  };
}

/** GLSL helpers shared by both materials. */
export const GLSL_COMMON = /* glsl */ `
  uniform float uTime;
  uniform sampler2D uField;
  uniform vec2 uGridOrigin;
  uniform vec2 uGridSize;
  uniform vec3 uFocus;
  uniform float uFadeRadius;
  uniform vec3 uLampPos;
  uniform vec3 uLampColor;
  uniform float uLampPower;
  uniform float uLampRange;
  uniform vec3 uWispPos;
  uniform vec3 uWispColor;
  uniform float uWispPower;
  uniform float uWispRange;
  uniform vec3 uAmbient;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  vec2 fieldUv(vec2 worldXZ) {
    return (worldXZ - uGridOrigin) / uGridSize;
  }

  vec4 sampleField(vec2 worldXZ) {
    vec2 uv = fieldUv(worldXZ);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
    return texture2D(uField, uv);
  }

  /** Warm lantern + cold wisp, cheap point lights with squared falloff. */
  vec3 ghostLights(vec3 worldPos, vec3 normal) {
    vec3 toLamp = uLampPos - worldPos;
    float lampDist = length(toLamp);
    float lampAtt = clamp(1.0 - lampDist / uLampRange, 0.0, 1.0);
    lampAtt *= lampAtt;
    float lampDiff = max(dot(normal, normalize(toLamp)), 0.0) * 0.75 + 0.25;
    float flicker = 0.88 + 0.12 * valueNoise(vec2(uTime * 2.4, 3.1));
    vec3 lamp = uLampColor * (lampAtt * lampDiff * uLampPower * flicker);

    vec3 toWisp = uWispPos - worldPos;
    float wispDist = length(toWisp);
    float wispAtt = clamp(1.0 - wispDist / uWispRange, 0.0, 1.0);
    wispAtt *= wispAtt;
    float wispDiff = max(dot(normal, normalize(toWisp)), 0.0) * 0.7 + 0.3;
    vec3 wisp = uWispColor * (wispAtt * wispDiff * uWispPower);

    return lamp + wisp;
  }

  /** Red-hot scorch and blue frost emissive, driven by the trail field. */
  vec3 trailGlow(vec4 field, float crackMask, vec2 worldXZ) {
    float heat = field.r;
    float cold = field.g;

    float ember = 0.78 + 0.22 * valueNoise(worldXZ * 3.0 + vec2(uTime * 0.6, uTime * 0.35));
    vec3 hot = mix(vec3(0.9, 0.14, 0.04), vec3(1.0, 0.42, 0.1), heat);
    vec3 heatTerm = hot * pow(heat, 1.3) * (0.45 + crackMask * 0.85) * 0.7 * ember;

    float shimmer = 0.82 + 0.18 * valueNoise(worldXZ * 2.2 - vec2(uTime * 0.35, uTime * 0.2));
    vec3 chill = mix(vec3(0.08, 0.3, 0.95), vec3(0.35, 0.8, 1.0), cold);
    vec3 coldTerm = chill * pow(cold, 1.15) * (0.45 + crackMask * 0.8) * 0.65 * shimmer;

    return heatTerm + coldTerm;
  }

  /** Ordered dither so walls between the camera and the ghost dissolve away. */
  float bayer(vec2 fragCoord) {
    vec2 p = floor(mod(fragCoord, 4.0));
    int index = int(p.x) + int(p.y) * 4;
    float m[16];
    m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
    m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
    m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
    m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
    float v = 0.0;
    for (int i = 0; i < 16; i++) {
      if (i == index) v = m[i];
    }
    return (v + 0.5) / 16.0;
  }
`;
