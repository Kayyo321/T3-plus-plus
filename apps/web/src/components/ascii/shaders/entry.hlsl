
void main() {
  float2 uv = (gl_FragCoord.xy + uFrame.xy) / uFrame.zw;
  // Cells are twice as tall as wide, so this keeps circles round on screen.
  float2 p = (uv * 2.0 - 1.0) * float2(uFrame.z / uFrame.w * 0.5, 1.0);
  outColor = float4(saturate(field(p, uTime)), 1.0);
}
