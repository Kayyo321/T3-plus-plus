// Astral: layered stars at different depths, twinkling, with faint constellations.
float star(float2 p, float scale, float t) {
  float2 cell = p * scale;
  float2 id = floor(cell);
  float2 local = frac(cell) - 0.5;
  float2 jitter = (float2(hash(id), hash(id + 7.7)) - 0.5) * 0.7;
  float glow = smoothstep(0.34, 0.0, length(local - jitter));
  float twinkle = 0.55 + 0.45 * sin(t * (0.5 + hash(id + 3.1) * 1.3) + hash(id) * 6.28);
  return glow * twinkle * step(0.7, hash(id + 1.3));
}

float segment(float2 p, float2 a, float2 b) {
  float2 pa = p - a;
  float2 ba = b - a;
  return length(pa - ba * saturate(dot(pa, ba) / dot(ba, ba)));
}

float3 field(float2 p, float t) {
  float near = star(p + float2(t * 0.012, 0.0), 8.0, t);
  float mid = star(p + float2(t * 0.007, 2.3), 15.0, t * 1.2) * 0.7;
  float far = star(p + float2(t * 0.003, 4.1), 28.0, t * 0.8) * 0.5;
  float lines = 0.0;
  float2 q = rotate(t * 0.006) * p;
  float2 last = float2(-1.3, -0.34);
  for (int i = 1; i < 7; i++) {
    float index = float(i);
    float2 next = float2(-1.3 + index * 0.43, sin(index * 2.4 + 0.7) * 0.5);
    lines += smoothstep(0.012, 0.0, segment(q, last, next));
    last = next;
  }
  float band = smoothstep(0.42, 0.72, fbm(rotate(0.5) * p * float2(0.9, 2.6) + t * 0.008)) * 0.2;
  return float3(near + mid + far + lines * 0.26 + band, saturate(near + lines), band * 5.0);
}
