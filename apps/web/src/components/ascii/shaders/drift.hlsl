// Drift: the contour map, for classic and custom themes.
float3 field(float2 p, float t) {
  float height = fbm(p * 1.4 + float2(t * 0.03, -t * 0.02));
  float contour = 1.0 - abs(frac(height * 7.0) - 0.5) * 2.0;
  float density = pow(contour, 3.0) * 0.7;
  return float3(density, height, contour);
}
