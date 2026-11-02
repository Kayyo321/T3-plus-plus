// Orbit: tilted rings with bodies sweeping along them.
float3 field(float2 p, float t) {
  float2 q = rotate(0.32) * p;
  q.y *= 2.5;
  float r = length(q);
  float a = atan2(q.y, q.x);
  float density = exp(-r * r * 30.0);
  float accent = density;
  for (int i = 1; i <= 4; i++) {
    float index = float(i);
    float ring = abs(r - index * 0.34);
    float line = smoothstep(0.07, 0.015, ring);
    float head = a - t * (0.62 / index) + index * 1.9;
    float trail = pow(0.5 + 0.5 * cos(head), 26.0);
    density += line * (0.42 + trail * 1.1);
    accent += line * trail;
  }
  float stars = smoothstep(0.992, 1.0, hash(floor(p * 28.0))) * 0.42;
  return float3(density + stars, saturate(accent), noise(q * 3.0 + t * 0.2));
}
