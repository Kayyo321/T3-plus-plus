import { describe, expect, it, vi } from "vite-plus/test";

import {
  registerChatThreadStarter,
  startThreadInWorkspaceMode,
  useWorkspaceMode,
} from "./workspaceMode";

describe("startThreadInWorkspaceMode", () => {
  it("starts Chat only while Chat is open, and leaves Code to the caller", async () => {
    const starter = vi.fn(async () => true);
    using _registered = { [Symbol.dispose]: registerChatThreadStarter(starter) };

    useWorkspaceMode.getState().setMode("code");
    expect(startThreadInWorkspaceMode()).toBeNull();
    expect(starter).not.toHaveBeenCalled();

    useWorkspaceMode.getState().setMode("chat");
    await expect(startThreadInWorkspaceMode()).resolves.toBe(true);
    expect(starter).toHaveBeenCalledOnce();
  });

  it("falls through when nothing has lent a starter yet", () => {
    useWorkspaceMode.getState().setMode("chat");
    expect(startThreadInWorkspaceMode()).toBeNull();
  });
});
