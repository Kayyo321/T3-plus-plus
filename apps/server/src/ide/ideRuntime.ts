import type { IdeThemeInput } from "@t3tools/contracts";

/** VSCodium's web server (REH-web): VS Code built from source, with Open VSX as its gallery. */
export const VSCODIUM_VERSION = "1.143.17232";

export const IDE_ROUTE_PREFIX = "/ide";

export interface IdeReleaseAsset {
  readonly url: string;
  readonly sha256: string;
}

const asset = (target: string, sha256: string): IdeReleaseAsset => ({
  url: `https://github.com/VSCodium/vscodium/releases/download/${VSCODIUM_VERSION}/vscodium-reh-web-${target}-${VSCODIUM_VERSION}.tar.gz`,
  sha256,
});

const WIN32_X64 = asset(
  "win32-x64",
  "391348e8fcecce9a6a14907d9663d5d0a67726abb2a001a71aaabe2616613489",
);

const IDE_RELEASE_ASSETS: Readonly<Partial<Record<string, IdeReleaseAsset>>> = {
  "linux-x64": asset(
    "linux-x64",
    "0d1e00fa4e3564617aba798a88395d9a5fb507d771d711e0454bb1065a030f7c",
  ),
  "linux-arm64": asset(
    "linux-arm64",
    "5ad0ccbda2010e99dbb8306fbabfcfd91c80a56ad579ad7903f6635b95d0615f",
  ),
  "darwin-x64": asset(
    "darwin-x64",
    "414a4d2ec2abd60d9a2704d0dd205c256e13ece2f162a3889b914e4a92fb2184",
  ),
  "darwin-arm64": asset(
    "darwin-arm64",
    "2a33e8d5c39cad9a1f6c81a56c908367a60738f08ff72304ff42b62652c41b01",
  ),
  "win32-x64": WIN32_X64,
  // VSCodium publishes no Windows ARM64 server; Windows 11 on ARM runs x64 under emulation.
  "win32-arm64": WIN32_X64,
};

export const ideReleaseAsset = (platform: string, arch: string): IdeReleaseAsset | undefined =>
  IDE_RELEASE_ASSETS[`${platform}-${arch}`];

/** The bundled Node and entry point. The `bin/` launchers are shell and .cmd wrappers around them. */
export const ideServerCommand = (
  platform: string,
  installDir: string,
  join: (...parts: string[]) => string,
) => ({
  command: join(installDir, platform === "win32" ? "node.exe" : "node"),
  entry: join(installDir, "out", "server-main.js"),
});

export const ideBasePath = (secret: string) => `${IDE_ROUTE_PREFIX}/${secret}`;

/** T3's own routes inside the editor's path, which VSCodium never serves. */
const IDE_AGENT_SEGMENT = ".t3pp";

export const ideAgentEndpointPath = (secret: string) =>
  `${ideBasePath(secret)}/${IDE_AGENT_SEGMENT}`;

/** `changes` or `hunk` for a request to T3's routes inside the editor's path. */
export const ideAgentRoute = (pathname: string): string | null =>
  /^\/ide\/[A-Za-z0-9_-]{16,}\/\.t3pp\/([a-z]+)$/.exec(pathname)?.[1] ?? null;

/** The capability in an editor request path, or null when the path is not an editor path. */
export const ideRequestSecret = (pathname: string): string | null => {
  const match = /^\/ide\/([A-Za-z0-9_-]{16,})(?:\/|$)/.exec(pathname);
  return match?.[1] ?? null;
};

/** VS Code reads `folder` as a URI path: forward slashes, and a leading slash before a drive. */
const ideFolderQueryPath = (platform: string, folder: string): string => {
  if (platform !== "win32") return folder;
  const forward = folder.replace(/\\/g, "/");
  return forward.startsWith("/") ? forward : `/${forward}`;
};

export const ideOpenPath = (secret: string, platform: string, folder: string) =>
  `${ideBasePath(secret)}/?folder=${encodeURIComponent(ideFolderQueryPath(platform, folder))}`;

/** Defaults T3 gives the editor. They are defaults, so a user can still change them there. */
export const IDE_WORKBENCH_DEFAULTS: Readonly<Record<string, unknown>> = {
  // T3's agents are the agents here, so VS Code's own chat and agent features stay off.
  "chat.disableAIFeatures": true,
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.tips.enabled": false,
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  // Agents already run in this folder; asking whether to trust it again only gets in the way.
  "security.workspace.trust.enabled": false,
  // Projects often sit inside a larger repository; T3 already works against it.
  "git.openRepositoryInParentFolders": "always",
};

const THEME_KEYS = [
  "workbench.colorTheme",
  "workbench.colorCustomizations",
  "editor.tokenColorCustomizations",
] as const;

/** Writes T3's theme into the editor's machine settings, where it outranks editor-side choices. */
export const mergeIdeMachineSettings = (
  existing: Readonly<Record<string, unknown>>,
  theme: IdeThemeInput | null,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...existing };
  if (theme === null) return next;
  for (const key of THEME_KEYS) delete next[key];
  return {
    ...next,
    "workbench.colorTheme":
      theme.appearance === "dark" ? "Default Dark Modern" : "Default Light Modern",
    "workbench.colorCustomizations": theme.colors,
    "editor.tokenColorCustomizations": { textMateRules: theme.tokenColors },
  };
};

/** Parses a settings file, which may hold comments and trailing commas. Null when unreadable. */
export const parseIdeSettings = (text: string): Record<string, unknown> | null => {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  if (stripped.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(stripped);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const WORKBENCH_SETTINGS =
  /(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]*)(")/;

const decodeAttribute = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const encodeAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * The workbench reads its connection token from its configuration before its cookie, and a
 * framed editor cannot rely on the cookie. Application-scoped defaults such as workspace trust
 * are only honored from here, not from machine settings.
 */
export const injectWorkbenchConfiguration = (html: string, token: string): string =>
  html.replace(WORKBENCH_SETTINGS, (whole, open: string, settings: string, close: string) => {
    try {
      const parsed: unknown = JSON.parse(decodeAttribute(settings));
      if (typeof parsed !== "object" || parsed === null) return whole;
      const configuration = {
        ...parsed,
        connectionToken: token,
        configurationDefaults: IDE_WORKBENCH_DEFAULTS,
      };
      return `${open}${encodeAttribute(JSON.stringify(configuration))}${close}`;
    } catch {
      return whole;
    }
  });

// T3's "++": two geometric plus signs with square ends, like the brand's monospace "++".
const LOGO_ARM = 26;
const LOGO_BAR = 6;
const LOGO_GAP = 10;

const logoShapes = () => {
  const left = (100 - (LOGO_ARM * 2 + LOGO_GAP)) / 2;
  const top = (100 - LOGO_ARM) / 2;
  const inset = (LOGO_ARM - LOGO_BAR) / 2;
  return [left, left + LOGO_ARM + LOGO_GAP]
    .map(
      (x) =>
        `<rect x="${x}" y="${top + inset}" width="${LOGO_ARM}" height="${LOGO_BAR}" rx="1"/>` +
        `<rect x="${x + inset}" y="${top}" width="${LOGO_BAR}" height="${LOGO_ARM}" rx="1"/>`,
    )
    .join("");
};

const logoSvg = (color: string, opacity: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g fill="${color}" opacity="${opacity}">${logoShapes()}</g></svg>`;

const IDE_BRAND_ASSETS: Readonly<Record<string, () => string>> = {
  "letterpress-dark.svg": () => logoSvg("#B2B2B2", 0.3),
  "letterpress-light.svg": () => logoSvg("#B2B2B2", 0.2),
  "letterpress-hcDark.svg": () => logoSvg("#3C3C3C", 1),
  "letterpress-hcLight.svg": () => logoSvg("#B2B2B2", 1),
  "code-icon.svg": () => logoSvg("#8A8A8A", 1),
};

/** T3's "++" in place of VSCodium's mark: the empty-editor watermark and the app icon. */
export const ideBrandAsset = (pathname: string): string | null => {
  const match = /\/static\/out\/media\/([A-Za-z-]+\.svg)$/.exec(pathname);
  const asset = match ? IDE_BRAND_ASSETS[match[1]!] : undefined;
  return asset ? asset() : null;
};
