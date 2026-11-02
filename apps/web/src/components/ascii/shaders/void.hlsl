// Void: a slow black hole. Dust spirals in toward a dark horizon, and a bright ring circles it.
float3 field(float2 p, float t) {
  float2 q = float2(p.x, p.y * 0.64);
  float r = length(q);
  float a = atan2(q.y, q.x);
  // The arms wind tighter toward the core, so they look like they are falling in.
  float swirl = a + 2.6 / (r + 0.3) - t * 0.32;
  float2 around = float2(cos(swirl), sin(swirl));
  float arms = fbm(around * 1.6 + float2(r * 2.4 - t * 0.14, t * 0.05));
  float disk = smoothstep(0.17, 0.36, r) * exp(-r * 1.25);
  float horizon = smoothstep(0.15, 0.25, r);
  float dust = smoothstep(0.36, 0.78, arms) * disk * horizon * 1.7;
  // A thin ring on the edge of the horizon, brightest on the side turning toward us.
  float radius = 0.235 + 0.012 * sin(t * 0.9);
  float offset = (r - radius) * 24.0;
  float ring = exp(-offset * offset);
  float hot = pow(0.5 + 0.5 * cos(a - t * 0.7), 10.0);
  float glow = ring * (0.5 + hot * 1.0);
  float stars = smoothstep(0.985, 1.0, hash(floor(p * 30.0)));
  float twinkle = 0.45 + 0.55 * sin(t * 1.7 + hash(floor(p * 30.0) + 3.0) * 6.28);
  float density = dust + glow + stars * twinkle * 0.55 * horizon;
  return float3(density, saturate(glow + dust * 0.25), arms);
}
