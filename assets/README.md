# Brand icons

Two masters in `assets/brand` are the source of truth for every icon:

- `t3pp-art.webp`: the full-bleed T3++ art. It is also the README header.
- `t3pp-app-icon.png`: the app icon. Its opaque body is the classic macOS safe area, 824×824
  inset 100px, on a white canvas that the export cuts away.

Run `vp run icons:export` from the repository root to regenerate the tracked macOS, iOS, Linux,
Windows, web, and Android assets from them, and `vp run icons:check` to verify that the tracked
files match without changing anything. It runs on any platform; there is no hand-exported icon.

The export renders three channels from the same masters. Production uses them as they are;
Nightly rotates the art's hue toward purple and development toward blue, so the channels stay
distinguishable in a dock. Each channel gets:

- a macOS icon with the native drop shadow, and a full-bleed rounded icon for iOS and Linux;
- Windows and web `.ico` files, 16 and 32px favicons, and a 180px Apple touch icon;
- an Icon Composer project (`app-icon.icon`) holding the art as a single flat layer, which iOS
  builds read directly;
- an Android adaptive-icon background, `apps/mobile/assets/android-icon-background-*.png`.

Android masks the centre of both adaptive-icon layers, so the art is the background layer and the
foreground stays empty. The splash, monochrome, and notification icons use the white T3++ wordmark
cut out of the art. The development web icons are also copied to `apps/web/public`.

Do not edit the generated PNG, ICO, or `app-icon.icon` files directly; change a master and rerun
the export.
