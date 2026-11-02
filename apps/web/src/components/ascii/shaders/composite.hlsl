uniform sampler2D uFieldFrom;
uniform sampler2D uFieldTo;
uniform sampler2D uGlyphs;
uniform sampler2D uLogo;
uniform float uMorph;
uniform int2 uCellPx;
uniform int uRampFrom;
uniform int uRampTo;
uniform int uLogoRow;
uniform float3 uInk;
uniform float3 uAccent;
uniform float2 uFocus;
uniform float4 uQuiet;
uniform float4 uQuietBelow;
uniform float uEdgeFade;
uniform int uGridShift;
uniform int2 uGridOffset;
uniform int2 uLogoShift;
uniform float2 uCanvasPx;

const int RAMP_LENGTH = 12;
const int RIPPLES = 4;
uniform float3 uRipples[RIPPLES];
uniform float uDissolve;

float glyph(int column, int row, int2 local) {
  return texelFetch(uGlyphs, int2(column, row) * uCellPx + local, 0).r;
}

void main() {
  // The field's grid stays put on the desktop; the mark's stays put in the window.
  int2 pixel = int2(gl_FragCoord.xy) + uGridOffset;
  int2 cell = pixel / uCellPx;
  int2 logoPixel = int2(gl_FragCoord.xy) + int2(uGridShift, 0) - uLogoShift;
  int2 logoCell = logoPixel / uCellPx;
  int2 logoLocal = int2(logoPixel.x % uCellPx.x, uCellPx.y - 1 - logoPixel.y % uCellPx.y);
  int2 cells = int2(uCells);
  // The atlas and logo are stored top down, the framebuffer is bottom up.
  int2 local = int2(pixel.x % uCellPx.x, uCellPx.y - 1 - pixel.y % uCellPx.y);
  float2 cellUv = ((float2(cell) + 0.5) * float2(uCellPx) - float2(uGridOffset)) / uCanvasPx;
  float2 aspect = float2(uCells.x / uCells.y * 0.5, 1.0);
  float2 fieldCell = float2(cell) + uFrame.xy;
  float scatter = hash(fieldCell);

  float2 push = float2(0.0);
  float wave = 0.0;
  for (int i = 0; i < RIPPLES; i++) {
    float age = uRipples[i].z;
    if (age < 0.0) continue;
    float2 away = (cellUv - uRipples[i].xy) * aspect;
    float r = length(away);
    float ring = exp(-pow((r - age * 1.05) * 10.0, 2.0)) * exp(-age * 1.9);
    ring += exp(-pow((r - age * 0.7) * 15.0, 2.0)) * exp(-age * 2.8) * 0.55;
    wave += ring;
    if (r > 0.001) push += away / r * ring;
  }
  int2 sampleCell = clamp(cell + int2(push * float2(12.0, 6.0)), int2(0), cells - 1);

  float reach = length((cellUv - uFocus) * float2(1.0, 0.7)) * 1.25;
  float edge = lerp(reach, scatter, 0.3);
  float m = smoothstep(edge - 0.14, edge + 0.14, uMorph * 1.3 - 0.15);
  float3 from = texelFetch(uFieldFrom, sampleCell, 0).rgb;
  float3 to = texelFetch(uFieldTo, sampleCell, 0).rgb;
  float3 f = lerp(from, to, m);
  float front = 4.0 * m * (1.0 - m);
  float bloom = sin(saturate(uDissolve * 2.0) * 3.14159) * exp(-reach * 2.2);
  f.x = saturate(f.x + front * 0.42 + wave * 0.55 + bloom * 0.5);
  f.y = saturate(f.y + wave * 0.7);
  f.z = saturate(f.z + wave * 0.6);

  // The whole field drifts between plain ASCII and Unicode, one patch of cells at a time.
  float tide = 0.5 + 0.5 * sin(uTime * 0.21);
  float pool = noise(fieldCell * float2(0.03, 0.06) + uTime * 0.05) + (scatter - 0.5) * 0.1;
  bool unicode = pool < tide * 1.25 - 0.1 + wave * 1.5 + uDissolve * 4.0;

  float fade = saturate(1.0 - length((cellUv - float2(uFocus.x, 0.54)) * float2(1.5, 1.22)));
  fade = lerp(1.0, fade * fade * (3.0 - 2.0 * fade), uEdgeFade);
  float2 outside = max(max(uQuiet.xy - cellUv, cellUv - uQuiet.zw), 0.0);
  float2 outsideBelow = max(max(uQuietBelow.xy - cellUv, cellUv - uQuietBelow.zw), 0.0);
  float quiet = smoothstep(0.0, 0.1, min(length(outside * aspect), length(outsideBelow * aspect)));
  fade *= lerp(lerp(0.08, 1.0, quiet), 1.0, saturate(uDissolve * 3.0));

  int2 logoSize = textureSize(uLogo, 0);
  bool onLogo = logoPixel.x >= 0 && logoPixel.y >= 0 && logoCell.x < logoSize.x && logoCell.y < logoSize.y;
  float4 logo = onLogo ? texelFetch(uLogo, int2(logoCell.x, logoSize.y - 1 - logoCell.y), 0) : float4(0.0);
  float3 ink = lerp(uInk, uAccent, saturate(f.y + front * 0.6));
  int ramp = (m > 0.5 ? uRampTo : uRampFrom) + (unicode ? 1 : 0);
  float logoGone = smoothstep(scatter * 0.32, scatter * 0.32 + 0.16, uDissolve * 1.5);
  float alpha;
  if (logo.a > 0.5 && logoGone < 0.02) {
    int shimmer = int(saturate(f.z * 0.65 + f.x * 0.35) * 2.999);
    int base = int(logo.r * 255.0 + 0.5);
    alpha = glyph(base == 0 ? shimmer : base + 2, uLogoRow, logoLocal) * (0.78 + f.z * 0.22);
    ink = lerp(uInk, uAccent, saturate(f.y * 0.75 + f.z * 0.25));
  } else if (logo.a > 0.5) {
    // A cell of the mark falls down the ramp until it is just more of the field.
    float density = lerp(1.0, f.x, logoGone);
    int level = int(density * float(RAMP_LENGTH) - 0.001);
    alpha = glyph(level, uRampTo + 1, logoLocal) * lerp(0.95, (0.1 + f.x * 0.62) * fade, logoGone);
  } else {
    int level = int(saturate(f.x) * float(RAMP_LENGTH) - 0.001);
    alpha = glyph(level, ramp, local) * (0.1 + f.x * 0.62) * fade;
  }

  float gone = lerp(reach, scatter, 0.4);
  alpha *= 1.0 - smoothstep(gone - 0.16, gone + 0.16, (uDissolve - 0.34) * 2.5);
  outColor = float4(ink * alpha, alpha);
}
