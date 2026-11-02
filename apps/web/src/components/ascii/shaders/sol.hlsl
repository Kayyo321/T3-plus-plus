// Sol: a sun climbing the horizon, its surface boiling and shedding flares.
float3 field(float2 p, float t) {
  float2 c = p - float2(0.0, -1.12);
  float r = length(c);
  float a = atan2(c.y, c.x);
  float radius = 0.92;
  float boil = fbm(c * 3.4 + float2(t * 0.09, -t * 0.13));
  float disc = smoothstep(radius + 0.02, radius - 0.02, r + boil * 0.08);
  float flare = fbm(float2(a * 5.0, r * 1.5 - t * 0.2));
  float corona = exp(-saturate(r - radius) * 3.4) * pow(flare, 1.6) * 2.2;
  float density = disc * (0.45 + boil * 0.8) + (1.0 - disc) * corona;
  return float3(density, saturate(disc + flare * 0.5), boil);
}
