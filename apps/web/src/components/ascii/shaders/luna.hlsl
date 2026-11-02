// Luna: a cratered moon turning through its phases.
float3 field(float2 p, float t) {
  float2 c = p - float2(0.0, 0.08);
  float radius = 0.86;
  float r = length(c) / radius;
  float sphere = sqrt(saturate(1.0 - r * r));
  float3 normal = float3(c / radius, sphere);
  float2 surface = normal.xy / (1.0 + sphere) * 3.2 + float2(t * 0.025, 0.0);
  float craters = fbm(surface);
  float pits = smoothstep(0.34, 0.62, noise(surface * 2.6));
  float angle = t * 0.09;
  float light = saturate(dot(normal, normalize(float3(cos(angle), 0.18, sin(angle) * 0.55 + 0.42))));
  float disc = step(r, 1.0);
  float limb = smoothstep(0.93, 1.0, r) * disc * 0.34;
  float density = disc * light * (0.3 + craters * 0.72) * (0.62 + pits * 0.38) + limb;
  return float3(density, craters, light);
}
