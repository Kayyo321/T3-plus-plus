import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "../../composerDraftStore";
import { rewindToMessage } from "./chatViewSend";

vi.mock("../ChatView.logic", () => ({
  prepareRevertedMessageAttachments: vi.fn(),
  waitForRevertedMessage: async (
    _threadRef: unknown,
    _turnCount: number,
    _commandId: CommandId,
    revert: () => Promise<void>,
  ) => revert(),
}));

describe("rewindToMessage", () => {
  it("leaves the composer alone when the prompt does not return", async () => {
    const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
    useComposerDraftStore.getState().setPrompt(threadRef, "unsent draft");
    const rewind = vi.fn(async () => ({ _tag: "Success", value: undefined }) as never);

    const result = await rewindToMessage({
      message: {
        id: MessageId.make("user-1"),
        role: "user",
        text: "selected prompt",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        runId: null,
        streaming: false,
      },
      environmentId: threadRef.environmentId,
      routeThreadRef: threadRef,
      threadId: threadRef.threadId,
      turnCount: 0,
      draftTarget: threadRef,
      composerHasPendingAttachments: true,
      restoresPrompt: false,
      createAssetUrl: vi.fn(),
      rewind,
    });

    expect(result).toEqual({ error: null, prompt: null });
    expect(rewind).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "unsent draft",
    );
  });
});
