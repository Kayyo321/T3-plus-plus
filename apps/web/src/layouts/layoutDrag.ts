import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { type LayoutDropZone, resolveDropZone } from "./layoutDocument";

export type LayoutDragPayload =
  | { readonly kind: "surface"; readonly threadKey: string; readonly surfaceId: string }
  | { readonly kind: "conversation"; readonly threadKey: string }
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef };

/** The drop target under the pointer. Changes only when the pointer crosses a zone. */
export interface LayoutDragHover {
  readonly targetId: string;
  readonly zone: LayoutDropZone;
}

interface LayoutDragState {
  readonly payload: LayoutDragPayload | null;
  readonly hover: LayoutDragHover | null;
}

export const useLayoutDragStore = create<LayoutDragState>(() => ({ payload: null, hover: null }));

const ACTIVATION_MARGIN_PX = 8;
const DRAGGING_ATTRIBUTE = "data-layout-dragging";
let dropHandled = false;

/** True once after a layout drag handled the drop, so a list's own drag end can stand down. */
export function consumeLayoutDrop(): boolean {
  const handled = dropHandled;
  dropHandled = false;
  return handled;
}

function hitTest(payload: LayoutDragPayload, x: number, y: number): LayoutDragHover | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (!(element instanceof HTMLElement)) continue;
    const { layoutDropGroup, layoutDropThread, layoutDropCenter, splitDropPane } = element.dataset;
    const bounds = element.getBoundingClientRect();
    if (payload.kind === "thread" && splitDropPane !== undefined) {
      return {
        targetId: splitDropPane,
        zone: resolveDropZone(bounds, { x, y: bounds.top + bounds.height / 2 }, true),
      };
    }
    if (
      payload.kind !== "thread" &&
      layoutDropGroup !== undefined &&
      layoutDropThread === payload.threadKey
    ) {
      const allowCenter = payload.kind === "surface" && layoutDropCenter === "true";
      return { targetId: layoutDropGroup, zone: resolveDropZone(bounds, { x, y }, allowCenter) };
    }
  }
  return null;
}

/**
 * Follows a pointer until it leaves `origin`, then reports drop targets. Pointer events, not HTML
 * drag, because tabs and sidebar rows already drag with dnd-kit and native drag would cancel it.
 */
export function beginLayoutDrag(input: {
  readonly event: Pick<PointerEvent, "button" | "clientX" | "clientY" | "pointerType">;
  readonly payload: LayoutDragPayload;
  readonly origin: Element;
  readonly onDrop: (hover: LayoutDragHover) => void;
}): void {
  if (input.event.button !== 0 || input.event.pointerType === "touch") return;
  const { payload, origin, onDrop } = input;
  let active = false;
  dropHandled = false;

  const stop = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("keydown", onKeyDown, true);
    if (!active) return;
    document.documentElement.removeAttribute(DRAGGING_ATTRIBUTE);
    useLayoutDragStore.setState({ payload: null, hover: null });
  };
  const onMove = (event: PointerEvent) => {
    if (!active) {
      const bounds = origin.getBoundingClientRect();
      const outside =
        event.clientX < bounds.left - ACTIVATION_MARGIN_PX ||
        event.clientX > bounds.right + ACTIVATION_MARGIN_PX ||
        event.clientY < bounds.top - ACTIVATION_MARGIN_PX ||
        event.clientY > bounds.bottom + ACTIVATION_MARGIN_PX;
      if (!outside) return;
      active = true;
      document.documentElement.setAttribute(DRAGGING_ATTRIBUTE, "");
      useLayoutDragStore.setState({ payload });
    }
    const hover = hitTest(payload, event.clientX, event.clientY);
    const current = useLayoutDragStore.getState().hover;
    if (current?.targetId !== hover?.targetId || current?.zone !== hover?.zone) {
      useLayoutDragStore.setState({ hover });
    }
  };
  const onUp = () => {
    const hover = useLayoutDragStore.getState().hover;
    const handled = active && hover !== null;
    stop();
    if (handled) {
      dropHandled = true;
      onDrop(hover);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") stop();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("keydown", onKeyDown, true);
}
