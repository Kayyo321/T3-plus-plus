// Void: sparse dust drifting through dark, almost nothing there.
float3 field(float2 p, float t) {
  float2 q = p * 2.2 + float2(t * 0.02, t * 0.012);
  float warp = fbm(q + fbm(q * 0.7 - t * 0.01) * 1.4);
  float contour = 1.0 - abs(frac(warp * 5.0) - 0.5) * 2.0;
  float dust = smoothstep(0.82, 1.0, contour) * smoothstep(0.25, 0.6, warp);
  float glint = smoothstep(0.985, 1.0, hash(floor(p * 34.0))) * (0.5 + 0.5 * sin(t * 0.8 + p.x * 9.0));
  return float3(dust * 0.62 + glint * 0.5, 0.0, warp);
}
