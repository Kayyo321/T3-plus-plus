import type { NestedSessionChildPolicy } from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

interface CloseRequest {
  readonly title: string;
  readonly childCount: number;
  readonly resolve: (choice: NestedSessionChildPolicy | null) => void;
}

export const nestedSessionCloseStore = createStore<{ request: CloseRequest | null }>(() => ({
  request: null,
}));

/** Asks what happens to a conversation's nested sessions when it closes. */
export function requestNestedSessionPolicy(input: {
  readonly title: string;
  readonly childCount: number;
}): Promise<NestedSessionChildPolicy | null> {
  nestedSessionCloseStore.getState().request?.resolve(null);
  return new Promise((resolve) =>
    nestedSessionCloseStore.setState({ request: { ...input, resolve } }),
  );
}

export function finishNestedSessionClose(choice: NestedSessionChildPolicy | null) {
  const { request } = nestedSessionCloseStore.getState();
  nestedSessionCloseStore.setState({ request: null });
  request?.resolve(choice);
}
