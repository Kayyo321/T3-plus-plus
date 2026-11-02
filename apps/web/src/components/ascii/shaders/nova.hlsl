// Nova: shockwaves leaving a core, torn into rays.
float3 field(float2 p, float t) {
  float r = length(p);
  float a = atan2(p.y, p.x);
  float rays = fbm(float2(a * 2.6, r * 0.7 - t * 0.16));
  float wave = frac(r * 1.25 - t * 0.14 + rays * 0.42);
  float shell = pow(1.0 - abs(wave - 0.5) * 2.0, 5.0);
  float falloff = exp(-r * 1.1);
  float core = exp(-r * r * 26.0);
  float density = shell * falloff * 1.35 + core + pow(rays, 3.0) * falloff * 1.1;
  return float3(density, saturate(shell + core), rays);
}
