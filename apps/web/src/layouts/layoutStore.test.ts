import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_LAYOUTS, LAYOUT_DOCUMENT_VERSION, type LayoutDocument } from "./layoutDocument";
import { findLayout, hydrateLayoutState, resolveDefaultLayout } from "./layoutStore";

const api = ProjectId.make("api");
const web = ProjectId.make("web");
const saved: LayoutDocument = { ...BUILT_IN_LAYOUTS[1]!, id: "mine", name: "Mine" };
const state = (overrides: Partial<Parameters<typeof resolveDefaultLayout>[0]> = {}) => ({
  saved: [saved],
  favoriteId: null,
  projectLayoutIds: {},
  ...overrides,
});

describe("resolveDefaultLayout", () => {
  it("starts on Focus", () => {
    expect(resolveDefaultLayout(state(), api).id).toBe("focus");
  });

  it("uses the favorite for every project", () => {
    expect(resolveDefaultLayout(state({ favoriteId: "mine" }), api).id).toBe("mine");
    expect(resolveDefaultLayout(state({ favoriteId: "mine" }), null).id).toBe("mine");
  });

  it("lets a project override the favorite, only for that project", () => {
    const overridden = state({ favoriteId: "mine", projectLayoutIds: { [api]: "debug" } });
    expect(resolveDefaultLayout(overridden, api).id).toBe("debug");
    expect(resolveDefaultLayout(overridden, web).id).toBe("mine");
  });

  it("falls through a reference to a deleted layout", () => {
    const stale = state({ favoriteId: "gone", projectLayoutIds: { [api]: "also-gone" } });
    expect(resolveDefaultLayout(stale, api).id).toBe("focus");
  });
});

describe("findLayout", () => {
  it("finds by id or by name in any case", () => {
    expect(findLayout(state(), "review")?.name).toBe("Review");
    expect(findLayout(state(), " MINE ")?.id).toBe("mine");
    expect(findLayout(state(), "nothing")).toBeNull();
  });
});

describe("hydrateLayoutState", () => {
  it("keeps a newer document without applying it, and drops a damaged one", () => {
    const newer = { version: LAYOUT_DOCUMENT_VERSION + 1, id: "later", name: "Later" };
    const hydrated = hydrateLayoutState({ saved: [saved, { version: 1, id: "broken" }, newer] });
    expect(hydrated.saved.map((layout) => layout.id)).toEqual(["mine"]);
    expect(hydrated.future).toEqual([newer]);
  });

  it("restores a kept document once this build can read it", () => {
    const hydrated = hydrateLayoutState({ saved: [], future: [saved] });
    expect(hydrated.saved.map((layout) => layout.id)).toEqual(["mine"]);
    expect(hydrated.future).toEqual([]);
  });

  it("does not let a stored document shadow a built-in", () => {
    expect(hydrateLayoutState({ saved: [{ ...saved, id: "review" }] }).saved).toEqual([]);
  });

  it("survives anything", () => {
    expect(hydrateLayoutState("nope")).toEqual({
      saved: [],
      future: [],
      favoriteId: null,
      projectLayoutIds: {},
    });
  });
});
