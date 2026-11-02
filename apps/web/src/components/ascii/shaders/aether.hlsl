// Aether: long ribbons of air sliding through one another.
float3 field(float2 p, float t) {
  float density = 0.0;
  float accent = 0.0;
  for (int i = 0; i < 5; i++) {
    float index = float(i);
    float speed = 0.1 + index * 0.024;
    float phase = sin(p.x * (1.1 + index * 0.35) + t * speed + index * 1.7);
    float bend = noise(float2(p.x * 0.8 - t * 0.04, index * 3.1)) - 0.5;
    float y = (index - 2.0) * 0.36 + phase * 0.2 + bend * 0.7;
    float ribbon = exp(-pow((p.y - y) * (9.0 + index * 2.0), 2.0));
    density += ribbon * (0.56 + 0.3 * sin(p.x * 3.0 - t * 0.3 + index));
    accent += ribbon * step(1.5, fmod(index, 3.0));
  }
  return float3(density, saturate(accent), noise(p * 2.0 + t * 0.1));
}
