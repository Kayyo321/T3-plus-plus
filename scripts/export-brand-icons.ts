import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

// The two masters are the brand: the full-bleed art and the app icon, whose opaque body is the
// classic macOS 824px safe area inset 100px on a white canvas.
const ART_MASTER = "assets/brand/t3pp-art.webp";
const APP_ICON_MASTER = "assets/brand/t3pp-app-icon.png";
const MACOS_BODY = { left: 100, top: 100, width: 824, height: 824 };
// Where the white T3++ wordmark sits in the art; the ASCII field around it stays out of the mark.
const WORDMARK_REGION = { left: 180, top: 370, width: 660, height: 280 };
const CORNER_RADIUS = 0.2237;
const ANDROID_CANVAS = 432;
const ANDROID_SPLASH_CANVAS = 1152;
const ANDROID_DIRECTORY = "apps/mobile/assets";

const VARIANTS = [
  {
    label: "production",
    hue: 0,
    iconProject: BRAND_ASSET_PATHS.productionIconComposerProject,
    macPng: BRAND_ASSET_PATHS.productionMacIconPng,
    roundedPngs: [BRAND_ASSET_PATHS.productionIosIconPng, BRAND_ASSET_PATHS.productionLinuxIconPng],
    windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    android: "prod",
  },
  {
    label: "nightly",
    hue: 250,
    iconProject: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    macPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
    roundedPngs: [BRAND_ASSET_PATHS.nightlyIosIconPng, BRAND_ASSET_PATHS.nightlyLinuxIconPng],
    windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    android: "nightly",
  },
  {
    label: "development",
    hue: 210,
    iconProject: BRAND_ASSET_PATHS.developmentIconComposerProject,
    macPng: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    roundedPngs: [
      BRAND_ASSET_PATHS.developmentIosIconPng,
      BRAND_ASSET_PATHS.developmentUniversalIconPng,
    ],
    windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    android: "dev",
  },
] as const;

// Icon Composer draws the art as one flat layer; iOS applies its own mask and glass.
// Written as oxfmt formats it, so `vp fmt --check` and `icons:check` agree.
const ICON_COMPOSER_PROJECT = `{
  "fill": {
    "solid": "display-p3:0.00000,0.00000,0.00000,1.00000"
  },
  "groups": [
    {
      "layers": [
        {
          "glass": false,
          "image-name": "art.png",
          "name": "Art",
          "position": {
            "scale": 1,
            "translation-in-points": [0, 0]
          }
        }
      ],
      "shadow": {
        "kind": "neutral",
        "opacity": 0.5
      },
      "translucency": {
        "enabled": false,
        "value": 0
      }
    }
  ],
  "supported-platforms": {
    "circles": ["watchOS"],
    "squares": "shared"
  }
}
`;

export class IconExportError extends Schema.TaggedError<IconExportError>()("IconExportError", {
  step: Schema.String,
  cause: Schema.Defect(),
}) {}

export class IconExportAssetsStaleError extends Schema.TaggedError<IconExportAssetsStaleError>()(
  "IconExportAssetsStaleError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `Generated icon assets are stale. Run \`vp run icons:export\`.\n${this.paths.join("\n")}`;
  }
}

const render = (step: string, build: () => Promise<Buffer>) =>
  Effect.tryPromise({ try: build, catch: (cause) => new IconExportError({ step, cause }) });

const png = (image: ReturnType<typeof sharp>) => image.png({ compressionLevel: 9 }).toBuffer();

const roundedMask = (size: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * CORNER_RADIUS}" fill="#fff"/></svg>`,
  );

// Inset 2px so the white canvas around the master's own rounded corners never shows.
const roundedBody = (body: Buffer, size: number) =>
  png(
    sharp(body)
      .extract({ left: 2, top: 2, width: MACOS_BODY.width - 4, height: MACOS_BODY.height - 4 })
      .resize(size, size)
      .composite([{ input: roundedMask(size), blend: "dest-in" }]),
  );

const transparent = (size: number) =>
  sharp({ create: { width: size, height: size, channels: 4, background: "#0000" } });

// Clears connected regions much smaller than the largest glyph, such as the letters' outline strokes.
const dropSpecks = (alpha: Buffer, width: number, height: number) => {
  const regions: number[][] = [];
  const seen = new Uint8Array(alpha.length);
  for (let start = 0; start < alpha.length; start++) {
    if (alpha[start] === 0 || seen[start] === 1) continue;
    const region: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const pixel = stack.pop()!;
      region.push(pixel);
      const x = pixel % width;
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x < width - 1 ? pixel + 1 : -1,
        pixel - width,
        pixel + width,
      ]) {
        if (next < 0 || next >= width * height || alpha[next] === 0 || seen[next] === 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    regions.push(region);
  }
  const largest = Math.max(...regions.map((region) => region.length));
  for (const region of regions) {
    if (region.length < largest * 0.1) for (const pixel of region) alpha[pixel] = 0;
  }
};

// Bright, unsaturated pixels are the wordmark; the median drops the thin ASCII strokes around it.
const renderWordmark = async (art: Buffer) => {
  const { data, info } = await sharp(art)
    .extract(WORDMARK_REGION)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = Buffer.alloc(info.width * info.height);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    const channels = [data[pixel * 3]!, data[pixel * 3 + 1]!, data[pixel * 3 + 2]!];
    const brightest = Math.max(...channels);
    alpha[pixel] = brightest > 170 && brightest - Math.min(...channels) < 40 ? 255 : 0;
  }
  dropSpecks(alpha, info.width, info.height);
  const trimmed = await sharp(alpha, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .median(9)
    .trim({ background: "#000", threshold: 10 })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return png(
    sharp({
      create: {
        width: trimmed.info.width,
        height: trimmed.info.height,
        channels: 3,
        background: "#fff",
      },
    }).joinChannel(trimmed.data, {
      raw: { width: trimmed.info.width, height: trimmed.info.height, channels: 1 },
    }),
  );
};

const centeredMark = async (wordmark: Buffer, canvas: number, width: number) =>
  png(
    transparent(canvas).composite([
      { input: await sharp(wordmark).resize({ width }).toBuffer(), gravity: "center" },
    ]),
  );

const renderAssets = Effect.fn("renderAssets")(function* (repositoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (relativePath: string) =>
    fs
      .readFile(path.join(repositoryRoot, relativePath))
      .pipe(
        Effect.mapError((cause) => new IconExportError({ step: `read ${relativePath}`, cause })),
      );
  const art = Buffer.from(yield* read(ART_MASTER));
  const appIcon = Buffer.from(yield* read(APP_ICON_MASTER));
  const generated = new Map<string, Buffer>();

  for (const variant of VARIANTS) {
    yield* Console.log(`Rendering ${variant.label} icons...`);
    const tintedArt = yield* render(`${variant.label} art`, () =>
      png(sharp(art).modulate({ hue: variant.hue }).resize(1024, 1024)),
    );
    const body = yield* render(`${variant.label} body`, () =>
      png(sharp(appIcon).extract(MACOS_BODY).modulate({ hue: variant.hue })),
    );
    const rounded = yield* render(`${variant.label} rounded icon`, () => roundedBody(body, 1024));
    for (const relativePath of variant.roundedPngs) generated.set(relativePath, rounded);

    generated.set(
      variant.macPng,
      yield* render(`${variant.label} macOS icon`, async () => {
        const shadow = await png(
          transparent(1024)
            .composite([
              {
                input: await png(
                  sharp({
                    create: { width: 824, height: 824, channels: 4, background: "#0000004d" },
                  }).composite([{ input: roundedMask(824), blend: "dest-in" }]),
                ),
                left: 100,
                top: 110,
              },
            ])
            .blur(12),
        );
        return png(
          sharp(shadow).composite([
            { input: await roundedBody(body, 824), left: MACOS_BODY.left, top: MACOS_BODY.top },
          ]),
        );
      }),
    );

    const sized = (size: number) =>
      render(`${variant.label} ${size}px icon`, () => png(sharp(rounded).resize(size, size)));
    const icoImages = [];
    for (const size of WINDOWS_ICON_SIZES) icoImages.push({ size, contents: yield* sized(size) });
    const ico = encodePngIco(icoImages);
    generated.set(variant.windowsIco, ico);
    generated.set(variant.faviconIco, ico);
    generated.set(variant.favicon16, yield* sized(16));
    generated.set(variant.favicon32, yield* sized(32));
    generated.set(variant.appleTouch, yield* sized(180));

    generated.set(`${variant.iconProject}/Assets/art.png`, tintedArt);
    generated.set(`${variant.iconProject}/icon.json`, Buffer.from(ICON_COMPOSER_PROJECT));

    // Android masks the centre of both adaptive layers, so the art is the background and the
    // foreground stays empty.
    generated.set(
      `${ANDROID_DIRECTORY}/android-icon-background-${variant.android}.png`,
      yield* render(`${variant.label} Android background`, () =>
        png(sharp(tintedArt).resize(ANDROID_CANVAS, ANDROID_CANVAS)),
      ),
    );
  }

  const wordmark = yield* render("wordmark", () => renderWordmark(art));
  // The Android 12 splash keeps the central circle of two thirds of its canvas.
  const splash = yield* render("Android splash", () =>
    centeredMark(wordmark, ANDROID_SPLASH_CANVAS, 640),
  );
  for (const variant of VARIANTS) {
    generated.set(`${ANDROID_DIRECTORY}/android-splash-icon-${variant.android}.png`, splash);
  }
  generated.set(
    `${ANDROID_DIRECTORY}/android-icon-mark.png`,
    yield* render("Android monochrome icon", () => centeredMark(wordmark, ANDROID_CANVAS, 250)),
  );
  generated.set(
    `${ANDROID_DIRECTORY}/android-notification-icon.png`,
    yield* render("Android notification icon", () => centeredMark(wordmark, 96, 80)),
  );
  generated.set(
    `${ANDROID_DIRECTORY}/android-icon-foreground.png`,
    yield* render("Android foreground", () => png(transparent(ANDROID_CANVAS))),
  );

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    generated.set(override.targetRelativePath, generated.get(override.sourceRelativePath)!);
  }
  return generated;
});

const exportBrandIcons = Effect.fn("exportBrandIcons")(function* (checkOnly: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const generated = yield* renderAssets(repositoryRoot);

  if (checkOnly) {
    const stale: string[] = [];
    for (const [relativePath, contents] of generated) {
      const current = yield* fs
        .readFile(path.join(repositoryRoot, relativePath))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (current === undefined || !Buffer.from(current).equals(contents)) stale.push(relativePath);
    }
    if (stale.length > 0) return yield* new IconExportAssetsStaleError({ paths: stale });
    yield* Console.log(`All ${generated.size} generated icon assets are current.`);
    return;
  }

  for (const [relativePath, contents] of generated) {
    const target = path.join(repositoryRoot, relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFile(target, contents);
  }
  yield* Console.log(`Updated ${generated.size} generated icon assets.`);
});

export const exportBrandIconsCommand = Command.make(
  "export-brand-icons",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Verify generated icon assets without modifying files."),
      Flag.withDefault(false),
    ),
  },
  ({ check }) => exportBrandIcons(check),
).pipe(
  Command.withDescription(
    "Render the app icons, favicons, and Android artwork from the T3++ brand masters.",
  ),
);

if (import.meta.main) {
  Command.run(exportBrandIconsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
