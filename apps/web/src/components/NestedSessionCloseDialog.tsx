import type { NestedSessionChildPolicy } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";

import {
  finishNestedSessionClose as finish,
  nestedSessionCloseStore,
} from "../lib/nestedSessionClose";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Radio, RadioGroup } from "./ui/radio-group";

const OPTIONS: ReadonlyArray<{
  readonly value: NestedSessionChildPolicy;
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "keep", label: "Keep them", detail: "They stay open and move up to the list." },
  { value: "archive", label: "Archive them", detail: "Stops any work and archives them too." },
  { value: "stop", label: "Stop them", detail: "Stops any work and leaves them open." },
];

export function NestedSessionCloseDialogHost() {
  const request = useStore(nestedSessionCloseStore, (state) => state.request);
  const [choice, setChoice] = useState<NestedSessionChildPolicy>("keep");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending request promise with null when the host unmounts
  useEffect(() => () => finish(null), []);
  if (request === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Close “{request.title}”?</DialogTitle>
          <DialogDescription>
            It has {request.childCount} nested {request.childCount === 1 ? "session" : "sessions"}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup
            value={choice}
            onValueChange={(value) => setChoice(value as NestedSessionChildPolicy)}
          >
            {OPTIONS.map((option) => (
              <Label key={option.value} className="items-start">
                <Radio value={option.value} />
                <span className="flex flex-col">
                  <span>{option.label}</span>
                  <span className="text-xs font-normal text-muted-foreground">{option.detail}</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button onClick={() => finish(choice)}>Close conversation</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
