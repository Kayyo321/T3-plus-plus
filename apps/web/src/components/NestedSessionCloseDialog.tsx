import { useEffect } from "react";
import { useStore } from "zustand";

import {
  finishNestedSessionClose as finish,
  finishNestedSessionDelete,
  nestedSessionCloseStore,
  nestedSessionDeleteStore,
} from "../lib/nestedSessionClose";

import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

function NestedSessionCloseDialog() {
  const request = useStore(nestedSessionCloseStore, (state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending request promise with null when the host unmounts
  useEffect(() => () => finish(null), []);
  if (request === null) return null;
  const one = request.childCount === 1;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive “{request.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It has {request.childCount} nested {one ? "thread" : "threads"}. Archive{" "}
            {one ? "it" : "all of them"} as well? Stopping leaves {one ? "it" : "them"} open with no
            work running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => finish("keep")}>
            Keep nested {one ? "thread" : "threads"}
          </Button>
          <Button variant="outline" onClick={() => finish("stop")}>
            Stop {one ? "it" : "them"}
          </Button>
          <Button onClick={() => finish("archive")}>Archive all</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function NestedSessionDeleteDialog() {
  const request = useStore(nestedSessionDeleteStore, (state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending request promise with null when the host unmounts
  useEffect(() => () => finishNestedSessionDelete(null), []);
  if (request === null) return null;
  const threads = request.childCount === 1 ? "thread" : "threads";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) finishNestedSessionDelete(null);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {request.subject}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently clears conversation history. Also delete the {request.childCount}{" "}
            nested {threads} underneath?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => finishNestedSessionDelete(null)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => finishNestedSessionDelete("keep")}>
            Keep nested {threads}
          </Button>
          <Button variant="destructive" onClick={() => finishNestedSessionDelete("delete")}>
            Delete all
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function NestedSessionCloseDialogHost() {
  return (
    <>
      <NestedSessionCloseDialog />
      <NestedSessionDeleteDialog />
    </>
  );
}
