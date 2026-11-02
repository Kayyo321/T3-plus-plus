// Nebula: gas folding over itself, lit from inside.
float3 field(float2 p, float t) {
  float2 q = float2(fbm(p * 1.3 + t * 0.018), fbm(p * 1.3 - float2(t * 0.014, 3.1)));
  float2 w = float2(fbm(p * 1.3 + q * 2.8 + float2(1.7, 9.2)), fbm(p * 1.3 + q * 2.8 + t * 0.02));
  float gas = fbm(p * 1.3 + w * 2.4);
  float density = smoothstep(0.3, 0.76, gas);
  return float3(density * density * 1.2, saturate(length(w) * 1.05 - 0.2), gas);
}
