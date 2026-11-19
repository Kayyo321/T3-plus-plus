import type { IdeThemeInput, IdeTokenColorRule } from "@t3tools/contracts";

import { readableSyntaxColor } from "../lib/readableSyntaxTheme";

/** T3 tokens the editor is painted from. Each resolves to `#rrggbb` or `#rrggbbaa`. */
const IDE_THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "popover",
  "popover-foreground",
  "muted-foreground",
  "border",
  "input",
  "primary",
  "primary-foreground",
  "accent",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-row-hover",
  "sidebar-row-active",
  "destructive",
  "warning",
  "success",
  "info",
  "diff-addition",
  "diff-deletion",
  "terminal-background",
  "terminal-foreground",
  "terminal-cursor",
  "terminal-selection-background",
] as const;

type IdeThemeToken = (typeof IDE_THEME_TOKENS)[number];
type ResolvedIdeTokens = Readonly<Record<IdeThemeToken, string>>;

const withAlpha = (hex: string, alpha: number) =>
  `${hex.slice(0, 7)}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

/** VS Code's color keys, painted the way T3 paints the same surfaces. */
function vscodeColorsFromTokens(t: ResolvedIdeTokens): Record<string, string> {
  const chrome = t.background;
  return {
    foreground: t.foreground,
    descriptionForeground: t["muted-foreground"],
    focusBorder: t.ring,
    "widget.border": t.border,
    "selection.background": withAlpha(t.primary, 0.3),
    errorForeground: t.destructive,
    "textLink.foreground": t.primary,
    "textLink.activeForeground": t.primary,
    "progressBar.background": t.primary,
    "badge.background": t.primary,
    "badge.foreground": t["primary-foreground"],
    "button.background": t.primary,
    "button.foreground": t["primary-foreground"],
    "button.secondaryBackground": t.accent,
    "button.secondaryForeground": t.foreground,
    "input.background": t.card,
    "input.border": t.input,
    "input.foreground": t.foreground,
    "input.placeholderForeground": t["muted-foreground"],
    "dropdown.background": t.popover,
    "dropdown.border": t.border,
    "dropdown.foreground": t["popover-foreground"],
    "checkbox.background": t.card,
    "checkbox.border": t.input,

    "titleBar.activeBackground": chrome,
    "titleBar.inactiveBackground": chrome,
    "titleBar.activeForeground": t.foreground,
    "titleBar.inactiveForeground": t["muted-foreground"],
    "titleBar.border": t.border,
    "activityBar.background": chrome,
    "activityBar.foreground": t.foreground,
    "activityBar.inactiveForeground": t["muted-foreground"],
    "activityBar.activeBackground": t.accent,
    "activityBar.activeBorder": withAlpha(t.primary, 0),
    "activityBar.border": t.border,
    "activityBarBadge.background": t.primary,
    "activityBarBadge.foreground": t["primary-foreground"],
    "sideBar.background": t.sidebar,
    "sideBar.foreground": t["sidebar-foreground"],
    "sideBar.border": t["sidebar-border"],
    "sideBarTitle.foreground": t["muted-foreground"],
    "sideBarSectionHeader.background": t.sidebar,
    "sideBarSectionHeader.foreground": t["muted-foreground"],
    "sideBarSectionHeader.border": t["sidebar-border"],
    "list.hoverBackground": t["sidebar-row-hover"],
    "list.activeSelectionBackground": t["sidebar-row-active"],
    "list.activeSelectionForeground": t.foreground,
    "list.inactiveSelectionBackground": t["sidebar-row-active"],
    "list.focusOutline": t.ring,
    "list.highlightForeground": t.primary,
    "tree.indentGuidesStroke": t.border,
    "toolbar.hoverBackground": t.accent,

    "editor.background": t.background,
    "editor.foreground": t.foreground,
    "editorLineNumber.foreground": withAlpha(t["muted-foreground"], 0.55),
    "editorLineNumber.activeForeground": t.foreground,
    "editor.lineHighlightBackground": t.accent,
    "editor.lineHighlightBorder": withAlpha(t.accent, 0),
    "editor.selectionBackground": withAlpha(t.primary, 0.3),
    "editor.inactiveSelectionBackground": withAlpha(t.primary, 0.15),
    "editorCursor.foreground": t["terminal-cursor"],
    "editorIndentGuide.background1": t.border,
    "editorWhitespace.foreground": t.border,
    "editorGroup.border": t.border,
    "editorGroupHeader.tabsBackground": chrome,
    "editorGroupHeader.tabsBorder": t.border,
    "tab.activeBackground": t.accent,
    "tab.unfocusedActiveBackground": t.accent,
    "tab.inactiveBackground": chrome,
    "tab.activeForeground": t.foreground,
    "tab.inactiveForeground": t["muted-foreground"],
    "tab.border": withAlpha(chrome, 0),
    "tab.activeBorderTop": withAlpha(chrome, 0),
    "tab.hoverBackground": t.accent,
    "breadcrumb.background": t.background,
    "breadcrumb.foreground": t["muted-foreground"],
    "editorWidget.background": t.popover,
    "editorWidget.border": t.border,
    "editorHoverWidget.background": t.popover,
    "editorHoverWidget.border": t.border,
    "editorSuggestWidget.background": t.popover,
    "editorSuggestWidget.border": t.border,
    "editorSuggestWidget.selectedBackground": t.accent,
    "quickInput.background": t.popover,
    "quickInputList.focusBackground": t.accent,
    "menu.background": t.popover,
    "menu.foreground": t["popover-foreground"],
    "menu.selectionBackground": t.accent,
    "menu.border": t.border,
    "notifications.background": t.popover,
    "notifications.border": t.border,
    "scrollbarSlider.background": withAlpha(t["muted-foreground"], 0.2),
    "scrollbarSlider.hoverBackground": withAlpha(t["muted-foreground"], 0.35),
    "scrollbarSlider.activeBackground": withAlpha(t["muted-foreground"], 0.45),

    "editorError.foreground": t.destructive,
    "editorWarning.foreground": t.warning,
    "editorInfo.foreground": t.info,
    "editorGutter.addedBackground": t.success,
    "editorGutter.modifiedBackground": t.primary,
    "editorGutter.deletedBackground": t.destructive,
    "diffEditor.insertedLineBackground": withAlpha(t["diff-addition"], 0.12),
    "diffEditor.removedLineBackground": withAlpha(t["diff-deletion"], 0.12),
    "gitDecoration.addedResourceForeground": t.success,
    "gitDecoration.untrackedResourceForeground": t.success,
    "gitDecoration.modifiedResourceForeground": t.warning,
    "gitDecoration.deletedResourceForeground": t.destructive,

    "panel.background": t.background,
    "panel.border": t.border,
    "panelTitle.activeForeground": t.foreground,
    "panelTitle.inactiveForeground": t["muted-foreground"],
    "panelTitle.activeBorder": t.primary,
    "statusBar.background": chrome,
    "statusBar.noFolderBackground": chrome,
    "statusBar.debuggingBackground": chrome,
    "statusBar.foreground": t["muted-foreground"],
    "statusBar.border": t.border,
    "statusBarItem.hoverBackground": t.accent,
    "statusBarItem.remoteBackground": chrome,
    "statusBarItem.remoteForeground": t["muted-foreground"],
    "terminal.background": t["terminal-background"],
    "terminal.foreground": t["terminal-foreground"],
    "terminalCursor.foreground": t["terminal-cursor"],
    "terminal.selectionBackground": t["terminal-selection-background"],
  };
}

interface VsCodeThemeFile {
  readonly tokenColors?: ReadonlyArray<{
    readonly scope?: string | ReadonlyArray<string>;
    readonly settings: { readonly foreground?: string; readonly fontStyle?: string };
  }>;
}

/** The same syntax colors T3's diffs and files use: pierre-dark, and pierre-light made readable. */
function tokenColorsFromPierre(
  theme: VsCodeThemeFile,
  appearance: "light" | "dark",
): IdeTokenColorRule[] {
  return (theme.tokenColors ?? []).map((rule) => {
    const foreground =
      rule.settings.foreground === undefined
        ? undefined
        : appearance === "light"
          ? readableSyntaxColor(rule.settings.foreground)
          : rule.settings.foreground;
    return {
      ...(rule.scope === undefined
        ? {}
        : { scope: typeof rule.scope === "string" ? rule.scope : [...rule.scope] }),
      settings: {
        ...(foreground === undefined ? {} : { foreground }),
        ...(rule.settings.fontStyle === undefined ? {} : { fontStyle: rule.settings.fontStyle }),
      },
    };
  });
}

const toHex = (bytes: Uint8ClampedArray) => {
  const [r = 0, g = 0, b = 0, a = 255] = bytes;
  const hex = [r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("");
  return a === 255 ? `#${hex}` : `#${hex}${a.toString(16).padStart(2, "0")}`;
};

const CONTRAST_TOKENS: ReadonlySet<IdeThemeToken> = new Set([
  "foreground",
  "popover-foreground",
  "muted-foreground",
  "border",
  "input",
  "sidebar-foreground",
  "sidebar-border",
]);

/** The variable Tailwind's `@theme inline` reads for each token; it emits no `--color-*`. */
const sourceVariable = (token: IdeThemeToken) =>
  CONTRAST_TOKENS.has(token) ? `--contrast-${token}` : `--${token}`;

/** Reads each token off the live document; oklch and color-mix resolve through the canvas. */
function readIdeTokens(root: HTMLElement): ResolvedIdeTokens {
  // The sidebar re-scopes its tokens, and the editor's explorer should match it.
  const sidebarScope = document.createElement("div");
  sidebarScope.dataset.appSidebar = "";
  sidebarScope.style.display = "none";
  const probe = document.createElement("span");
  const sidebarProbe = document.createElement("span");
  sidebarScope.append(sidebarProbe);
  probe.style.display = "none";
  root.append(probe, sidebarScope);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const resolved = {} as Record<IdeThemeToken, string>;
  for (const token of IDE_THEME_TOKENS) {
    const target = token.startsWith("sidebar") ? sidebarProbe : probe;
    target.style.color = `var(${sourceVariable(token)})`;
    const color = getComputedStyle(target).color;
    if (context === null) {
      resolved[token] = "#000000";
      continue;
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#00000000";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    resolved[token] = toHex(context.getImageData(0, 0, 1, 1).data);
  }
  probe.remove();
  sidebarScope.remove();
  return resolved;
}

export async function buildIdeTheme(
  root: HTMLElement,
  appearance: "light" | "dark",
): Promise<IdeThemeInput> {
  const pierre =
    appearance === "dark"
      ? await import("@pierre/theme/themes/pierre-dark.json")
      : await import("@pierre/theme/themes/pierre-light.json");
  return {
    appearance,
    colors: vscodeColorsFromTokens(readIdeTokens(root)),
    tokenColors: tokenColorsFromPierre(pierre.default as VsCodeThemeFile, appearance),
  };
}
