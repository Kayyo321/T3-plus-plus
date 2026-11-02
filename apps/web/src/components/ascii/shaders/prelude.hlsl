#version 300 es
// Browsers only run GLSL and WGSL, so these macros let the field shaders be written in HLSL.
precision highp float;

#define float2 vec2
#define float3 vec3
#define float4 vec4
#define int2 ivec2
#define float2x2 mat2
#define lerp mix
#define frac fract
#define fmod mod
#define saturate(x) clamp((x), 0.0, 1.0)
#define atan2(y, x) atan((y), (x))

uniform float2 uCells;
uniform float uTime;
uniform float uSeed;

out float4 outColor;

float hash(float2 p) {
  return frac(sin(dot(p + uSeed, float2(127.1, 311.7))) * 43758.5453);
}

float noise(float2 p) {
  float2 i = floor(p);
  float2 f = frac(p);
  f = f * f * (3.0 - 2.0 * f);
  return lerp(
    lerp(hash(i), hash(i + float2(1, 0)), f.x),
    lerp(hash(i + float2(0, 1)), hash(i + float2(1, 1)), f.x),
    f.y
  );
}

float fbm(float2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * noise(p);
    p = p * 2.03 + float2(11.3, 7.1);
    amplitude *= 0.5;
  }
  return sum;
}

float2x2 rotate(float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return float2x2(c, s, -s, c);
}
