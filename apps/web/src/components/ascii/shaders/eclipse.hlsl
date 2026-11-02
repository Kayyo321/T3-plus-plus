// Eclipse: a black disc with the corona streaming out from behind it.
float3 field(float2 p, float t) {
  float2 c = p - float2(0.0, 0.1);
  float r = length(c);
  float a = atan2(c.y, c.x);
  float radius = 0.52;
  float streamers = fbm(float2(a * 3.2 + sin(a) * 0.6, r * 0.8 - t * 0.09));
  float reach = exp(-max(r - radius, 0.0) * (3.2 - streamers * 2.4));
  float ring = exp(-abs(r - radius) * 26.0);
  float pulse = 0.82 + 0.18 * sin(t * 0.5);
  float bead = pow(0.5 + 0.5 * cos(a - t * 0.22), 90.0) * ring * 2.4;
  float density = step(radius, r) * (reach * streamers * 1.5 * pulse + ring * 0.8 + bead);
  return float3(density, saturate(ring + bead), streamers);
}
