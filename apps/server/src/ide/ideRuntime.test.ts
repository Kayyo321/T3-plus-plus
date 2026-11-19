import { describe, expect, it } from "vite-plus/test";

import {
  IDE_WORKBENCH_DEFAULTS,
  ideOpenPath,
  injectWorkbenchConfiguration,
  ideReleaseAsset,
  ideRequestSecret,
  mergeIdeMachineSettings,
  parseIdeSettings,
} from "./ideRuntime.ts";

const theme = {
  appearance: "dark" as const,
  colors: { "editor.background": "#000000" },
  tokenColors: [{ scope: "comment", settings: { foreground: "#737373" } }],
};

describe("ideOpenPath", () => {
  it("passes POSIX folders through and turns Windows drives into URI paths", () => {
    expect(ideOpenPath("a".repeat(32), "linux", "/home/me/my app")).toBe(
      `/ide/${"a".repeat(32)}/?folder=${encodeURIComponent("/home/me/my app")}`,
    );
    expect(ideOpenPath("a".repeat(32), "win32", "C:\\Users\\me\\app")).toBe(
      `/ide/${"a".repeat(32)}/?folder=${encodeURIComponent("/C:/Users/me/app")}`,
    );
  });
});

describe("ideRequestSecret", () => {
  it("reads the capability from editor paths only", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    expect(ideRequestSecret(`/ide/${secret}/`)).toBe(secret);
    expect(ideRequestSecret(`/ide/${secret}`)).toBe(secret);
    expect(ideRequestSecret(`/ide/${secret}/stable-1/static/out/main.js`)).toBe(secret);
    expect(ideRequestSecret("/ide/short/")).toBeNull();
    expect(ideRequestSecret("/ide/")).toBeNull();
    expect(ideRequestSecret(`/api/ide/${secret}/`)).toBeNull();
  });
});

describe("mergeIdeMachineSettings", () => {
  it("keeps the user's settings and replaces only the theme keys T3 owns", () => {
    const first = mergeIdeMachineSettings(
      { "editor.fontSize": 15, "workbench.colorCustomizations": { stale: "#fff" } },
      theme,
    );
    expect(first["editor.fontSize"]).toBe(15);
    expect(first["workbench.colorCustomizations"]).toEqual(theme.colors);
    expect(first["editor.tokenColorCustomizations"]).toEqual({ textMateRules: theme.tokenColors });

    const light = mergeIdeMachineSettings(first, { ...theme, appearance: "light" });
    expect(light["workbench.colorTheme"]).toBe("Default Light Modern");
    expect(light["editor.fontSize"]).toBe(15);
  });

  it("leaves an existing theme alone until the client sends one", () => {
    const merged = mergeIdeMachineSettings({ "workbench.colorTheme": "Mine" }, null);
    expect(merged["workbench.colorTheme"]).toBe("Mine");
  });
});

describe("parseIdeSettings", () => {
  it("reads VS Code's comments and trailing commas, and refuses what it cannot read", () => {
    expect(
      parseIdeSettings('{\n  // font\n  "editor.fontSize": 14, /* x */\n  "a": "b//c",\n}\n'),
    ).toEqual({ "editor.fontSize": 14, a: "b//c" });
    expect(parseIdeSettings("")).toEqual({});
    expect(parseIdeSettings("{ nope")).toBeNull();
    expect(parseIdeSettings("[]")).toBeNull();
  });
});

describe("ideReleaseAsset", () => {
  it("pins a checksum per platform and runs x64 on Windows ARM", () => {
    expect(ideReleaseAsset("darwin", "arm64")?.url).toContain("darwin-arm64");
    expect(ideReleaseAsset("win32", "arm64")).toEqual(ideReleaseAsset("win32", "x64"));
    expect(ideReleaseAsset("freebsd", "x64")).toBeUndefined();
  });
});

describe("injectWorkbenchConfiguration", () => {
  it("adds the token and T3's defaults to the workbench configuration and keeps the page", () => {
    const settings = JSON.stringify({
      remoteAuthority: "host:1",
      serverBasePath: "/ide/x",
      note: "a<b & 'c'",
    })
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");
    const html = `<head><meta id="vscode-workbench-web-configuration" data-settings="${settings}"><title>t</title></head>`;
    const result = injectWorkbenchConfiguration(html, "tok");
    const attribute = /data-settings="([^"]*)"/.exec(result)?.[1] ?? "";
    const decoded = JSON.parse(
      attribute
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    );
    expect(decoded).toEqual({
      remoteAuthority: "host:1",
      serverBasePath: "/ide/x",
      note: "a<b & 'c'",
      connectionToken: "tok",
      configurationDefaults: IDE_WORKBENCH_DEFAULTS,
    });
    expect(result.endsWith("<title>t</title></head>")).toBe(true);
    expect(injectWorkbenchConfiguration("<p>no editor</p>", "tok")).toBe("<p>no editor</p>");
  });
});
