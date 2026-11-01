import { type FormEvent, useState } from "react";
import { create } from "zustand";

import { readFocusedThreadRef, saveCurrentLayout } from "../../layouts/layoutActions";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const useSaveLayoutRequest = create<{ open: boolean }>(() => ({ open: false }));

/** Asks to name and save what the focused conversation shows now. */
export function requestSaveLayout(): void {
  useSaveLayoutRequest.setState({ open: true });
}

export function SaveLayoutDialogHost() {
  const open = useSaveLayoutRequest((state) => state.open);
  return (
    <SaveLayoutDialog
      open={open}
      onClose={() => useSaveLayoutRequest.setState({ open: false })}
      onSave={(name) => {
        const threadRef = readFocusedThreadRef();
        if (threadRef) saveCurrentLayout(threadRef, name);
      }}
    />
  );
}

/** Names a layout, for saving a new one or renaming a saved one. */
export function SaveLayoutDialog(props: {
  open: boolean;
  initialName?: string;
  title?: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? props.initialName ?? "";
  const close = () => {
    setDraft(null);
    props.onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length === 0) return;
    props.onSave(name);
    close();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{props.title ?? "Save layout"}</DialogTitle>
            <DialogDescription>
              Layouts keep panel positions and sizes on this device, not conversation content.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              nativeInput
              aria-label="Layout name"
              autoFocus
              placeholder="Layout name"
              value={name}
              onChange={(event) => setDraft(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim().length === 0}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
