/**
 * T3's margin extension for the editor: marks what the open thread's agent changed in its latest
 * turn, badges those files, and offers Accept and Revert per hunk. It runs in the editor's
 * extension host beside the server and reads `T3PP_IDE_ENDPOINT`, which IdeService sets. Kept as
 * plain JavaScript text so it ships inside the server bundle.
 */
export const IDE_MARGIN_EXTENSION_DIR = "t3pp-margin";

const LANE_DEFAULTS = [
  ["#0284c7", "#38bdf8"],
  ["#7c3aed", "#a78bfa"],
  ["#059669", "#34d399"],
  ["#d97706", "#fbbf24"],
  ["#e11d48", "#fb7185"],
  ["#0891b2", "#22d3ee"],
  ["#c026d3", "#e879f9"],
  ["#4d7c0f", "#a3e635"],
] as const;

const manifest = {
  name: IDE_MARGIN_EXTENSION_DIR,
  displayName: "T3++ Margin",
  description: "Shows what your T3++ agents changed, with Accept and Revert per change.",
  publisher: "t3pp",
  version: "1.0.0",
  license: "MIT",
  engines: { vscode: "^1.90.0" },
  extensionKind: ["workspace"],
  main: "./extension.js",
  activationEvents: ["onStartupFinished"],
  contributes: {
    colors: LANE_DEFAULTS.map(([light, dark], lane) => ({
      id: `t3pp.lane${lane}`,
      description: `T3++ agent color ${lane + 1}.`,
      defaults: { light, dark, highContrast: dark, highContrastLight: light },
    })),
    commands: [
      {
        command: "t3pp.margin.showAccepted",
        title: "Show Accepted Agent Changes Again",
        category: "T3++",
      },
    ],
  },
};

const source = String.raw`"use strict";
const vscode = require("vscode");

const ENDPOINT = process.env.T3PP_IDE_ENDPOINT;
const LANE_DEFAULTS = ${JSON.stringify(LANE_DEFAULTS)};
const ACCEPTED_KEY = "t3pp.margin.accepted";
const RETRY_MS = 5000;

const key = (fsPath) => (process.platform === "win32" ? fsPath.toLowerCase() : fsPath);

function laneColor(lane) {
  const custom = vscode.workspace.getConfiguration("workbench").get("colorCustomizations") || {};
  const dark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light &&
    vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.HighContrastLight;
  const value = custom["t3pp.lane" + lane];
  return typeof value === "string" ? value.slice(0, 7) : LANE_DEFAULTS[lane][dark ? 1 : 0];
}

function gutterIcon(color, kind) {
  const shape =
    kind === "removed"
      ? '<path d="M5 0h4l-4 4z" fill="' + color + '"/>'
      : kind === "modified"
        ? '<rect x="5" y="0" width="3" height="16" fill="' + color + '" fill-opacity="0.55"/>'
        : '<rect x="5" y="0" width="3" height="16" fill="' + color + '"/>';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    shape +
    "</svg>";
  return vscode.Uri.parse("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"));
}

async function request(method, route, body, signal) {
  const response = await fetch(ENDPOINT + "/" + route, {
    method,
    signal,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "T3++ did not answer.");
  return payload;
}

function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!ENDPOINT || !folder) return;
  const folderPath = folder.uri.fsPath;
  const aborter = new AbortController();
  context.subscriptions.push({ dispose: () => aborter.abort() });

  let feed = { version: "", thread: null, files: [] };
  let accepted = new Set(context.workspaceState.get(ACCEPTED_KEY, []));
  let types = null;
  let decorated = [];
  const lensesChanged = new vscode.EventEmitter();
  const decorationsChanged = new vscode.EventEmitter();
  context.subscriptions.push(lensesChanged, decorationsChanged);

  const live = (file) => file.hunks.filter((hunk) => !accepted.has(hunk.id));
  const fileFor = (uri) => feed.files.find((file) => key(file.path) === key(uri.fsPath));

  function decorationTypes() {
    if (types !== null || feed.thread === null) return types;
    const lane = feed.thread.lane;
    const color = laneColor(lane);
    const ruler = new vscode.ThemeColor("t3pp.lane" + lane);
    const make = (kind) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon(color, kind),
        gutterIconSize: "cover",
        overviewRulerColor: ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: true,
      });
    types = { lane, added: make("added"), modified: make("modified"), removed: make("removed") };
    return types;
  }

  function disposeTypes() {
    if (types === null) return;
    types.added.dispose();
    types.modified.dispose();
    types.removed.dispose();
    types = null;
  }

  function decorate(editor) {
    const current = decorationTypes();
    if (current === null) return;
    const file = fileFor(editor.document.uri);
    const ranges = { added: [], modified: [], removed: [] };
    const hover = feed.thread
      ? new vscode.MarkdownString(feed.thread.initial + " · " + feed.thread.title + " changed this")
      : undefined;
    for (const hunk of file ? live(file) : []) {
      for (const change of hunk.changes) {
        const last = Math.max(change.line, change.line + change.count - 1);
        for (let line = change.line; line <= last; line += 1) {
          if (line > editor.document.lineCount) break;
          ranges[change.kind].push({
            range: new vscode.Range(line - 1, 0, line - 1, 0),
            hoverMessage: hover,
          });
        }
      }
    }
    editor.setDecorations(current.added, ranges.added);
    editor.setDecorations(current.modified, ranges.modified);
    editor.setDecorations(current.removed, ranges.removed);
  }

  function render() {
    vscode.window.visibleTextEditors.forEach(decorate);
    lensesChanged.fire();
    const uris = new Map();
    for (const path of decorated) uris.set(key(path), vscode.Uri.file(path));
    decorated = feed.files.map((file) => file.path);
    for (const path of decorated) uris.set(key(path), vscode.Uri.file(path));
    decorationsChanged.fire([...uris.values()]);
  }

  function apply(next) {
    if (next.version !== feed.version) {
      const ids = new Set(next.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
      accepted = new Set([...accepted].filter((id) => ids.has(id)));
      void context.workspaceState.update(ACCEPTED_KEY, [...accepted]);
    }
    if (types !== null && (next.thread === null || types.lane !== next.thread.lane)) disposeTypes();
    feed = next;
    render();
  }

  async function refresh() {
    try {
      apply(await request("GET", "changes?folder=" + encodeURIComponent(folderPath), undefined, aborter.signal));
    } catch {}
  }

  async function follow() {
    while (!aborter.signal.aborted) {
      try {
        const query = "changes?folder=" + encodeURIComponent(folderPath) + "&after=" + encodeURIComponent(feed.version);
        apply(await request("GET", query, undefined, aborter.signal));
      } catch {
        if (aborter.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  async function act(action, path, hunkId) {
    if (feed.thread === null) return;
    const document = vscode.workspace.textDocuments.find((doc) => key(doc.uri.fsPath) === key(path));
    if (document && document.isDirty && !(await document.save())) return;
    const thread = feed.thread;
    try {
      await request("POST", "hunk", {
        folder: folderPath,
        threadId: thread.id,
        turn: thread.turn,
        path,
        hunkId,
        action,
      });
    } catch (error) {
      void vscode.window.showWarningMessage(error.message);
      return;
    }
    await refresh();
    if (action === "revert") {
      const choice = await vscode.window.showInformationMessage(
        "Reverted " + thread.initial + "'s change.",
        "Undo",
      );
      if (choice === "Undo") await act("reapply", path, hunkId);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("t3pp.margin.accept", (path, hunkId) => {
      accepted.add(hunkId);
      void context.workspaceState.update(ACCEPTED_KEY, [...accepted]);
      render();
    }),
    vscode.commands.registerCommand("t3pp.margin.revert", (path, hunkId) => act("revert", path, hunkId)),
    vscode.commands.registerCommand("t3pp.margin.showAccepted", () => {
      accepted = new Set();
      void context.workspaceState.update(ACCEPTED_KEY, []);
      render();
    }),
    vscode.languages.registerCodeLensProvider(
      { scheme: "file" },
      {
        onDidChangeCodeLenses: lensesChanged.event,
        provideCodeLenses(document) {
          const file = fileFor(document.uri);
          if (!file || feed.thread === null) return [];
          return live(file).flatMap((hunk) => {
            const first = hunk.changes[0];
            if (!first) return [];
            const line = Math.min(first.line, document.lineCount) - 1;
            const range = new vscode.Range(line, 0, line, 0);
            return [
              new vscode.CodeLens(range, { title: feed.thread.initial + " · " + feed.thread.title, command: "" }),
              new vscode.CodeLens(range, {
                title: "$(check) Accept",
                tooltip: "Keep this change",
                command: "t3pp.margin.accept",
                arguments: [file.path, hunk.id],
              }),
              new vscode.CodeLens(range, {
                title: "$(discard) Revert",
                tooltip: "Put these lines back the way they were before the agent's turn",
                command: "t3pp.margin.revert",
                arguments: [file.path, hunk.id],
              }),
            ];
          });
        },
      },
    ),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: decorationsChanged.event,
      provideFileDecoration(uri) {
        const file = fileFor(uri);
        if (!file || feed.thread === null) return undefined;
        if (file.hunks.length > 0 && live(file).length === 0) return undefined;
        return {
          badge: feed.thread.initial,
          color: new vscode.ThemeColor("t3pp.lane" + feed.thread.lane),
          tooltip: "Changed by " + feed.thread.title,
          propagate: true,
        };
      },
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach(decorate)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (fileFor(document.uri)) void refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("workbench.colorCustomizations")) return;
      disposeTypes();
      render();
    }),
    { dispose: disposeTypes },
  );
  void refresh().then(follow);
}

exports.activate = activate;
`;

/** Files of the extension, by name within its folder. */
export const IDE_MARGIN_EXTENSION: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
  "extension.js": source,
};
