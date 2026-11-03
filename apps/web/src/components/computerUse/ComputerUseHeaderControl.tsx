import type { ScopedThreadRef } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { showComputerUseSteps, startComputerUse } from "./computerUseActions";
import { useComputerUseControls } from "./useComputerUse";

/** Turns computer use on for one conversation. Absent wherever that is not on offer. */
export function ComputerUseHeaderControl({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { start } = useComputerUseControls(threadRef);
  if (start === null) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost-muted" aria-label="Turn on computer use" />}
      >
        <MonitorIcon aria-hidden className="size-3.5" />
        <span className="ml-0.5 max-sm:hidden @max-[20rem]/chat-header:hidden">Computer use</span>
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={6} className="max-w-72">
        <MenuGroup>
          <MenuGroupLabel>Turn on computer use here</MenuGroupLabel>
          {start.targets.map((option) => (
            <MenuItem
              key={option.target}
              disabled={option.disabledReason !== null}
              onClick={() => void startComputerUse(threadRef, option.target)}
            >
              <span className="flex min-w-0 flex-col">
                <span>{option.label}</span>
                {option.disabledReason === null ? null : (
                  <span className="text-muted-foreground text-xs">{option.disabledReason}</span>
                )}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
        {start.providerSupported ? (
          <p className="px-2 py-1 text-muted-foreground text-xs">{start.providerNote}</p>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => showComputerUseSteps(threadRef)}>Show steps</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
