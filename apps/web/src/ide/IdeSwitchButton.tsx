import { useAtomValue } from "@effect/atom-react";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useIdeSurface, type WindowSurface } from "./ideSurfaceStore";

/** "IDE ↗" in the conversation header, "Chat ↙" in the IDE header: the same control both ways. */
export function IdeSwitchButton(props: { readonly target: WindowSurface }) {
  const setSurface = useIdeSurface((state) => state.setSurface);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "ide.toggle");
  const toIde = props.target === "ide";
  const label = toIde ? "Open the IDE" : "Back to chat";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="secondary"
            size="xs"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={label}
            data-ide-switch={props.target}
            onClick={() => setSurface(props.target)}
          />
        }
      >
        {toIde ? "IDE" : "Chat"}
        {toIde ? <ArrowUpRightIcon /> : <ArrowDownLeftIcon />}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
