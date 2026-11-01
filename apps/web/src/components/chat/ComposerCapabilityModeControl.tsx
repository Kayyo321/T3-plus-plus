import type { ScopedThreadRef, ThreadCapabilityMode } from "@t3tools/contracts";
import { CodeIcon, MessageCircleIcon } from "lucide-react";

import type { DraftId } from "~/composerDraftStore";
import { useScratchProject } from "~/hooks/useScratchProject";
import { setThreadCapabilityMode } from "~/lib/threadCapabilityMode";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CAPABILITY_MODE_DESCRIPTIONS,
  CAPABILITY_MODE_LABELS,
  capabilityModeSwitch,
} from "./capabilityMode.logic";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const MODE_ICONS = { chat: MessageCircleIcon, code: CodeIcon } as const;
const MODES = ["chat", "code"] as const;

/** Chat or Code, for a draft and a started conversation alike. Measured by the resting row. */
export function ComposerCapabilityModeControl(props: {
  threadRef: ScopedThreadRef | null;
  draftId: DraftId | null;
  mode: ThreadCapabilityMode;
  runActive: boolean;
  canOperate: boolean;
  size: "sm" | "xs";
  hidden: boolean;
}) {
  const { draftId, threadRef, mode, size } = props;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const { setDraftCapabilityMode } = useScratchProject();
  const change = capabilityModeSwitch({
    mode,
    runActive: props.runActive,
    canOperate: props.canOperate,
  });
  const label = CAPABILITY_MODE_LABELS[mode];
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  data-composer-capability-mode={mode}
                  size={size}
                  className="ps-1.5"
                  aria-label={`Mode: ${label}`}
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={MODE_ICONS[mode]} size={size} />
          <span
            data-composer-control-label
            className={size === "xs" && mode === "code" ? "sr-only" : undefined}
          >
            {label}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {label}: {CAPABILITY_MODE_DESCRIPTIONS[mode]}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <div className="grid w-64 gap-1 px-2 py-1.5">
          {draftId !== null ? (
            <MenuRadioGroup
              aria-label="Mode"
              value={mode}
              onValueChange={(value: ThreadCapabilityMode) => {
                if (value !== mode) void setDraftCapabilityMode(draftId, value);
              }}
            >
              {MODES.map((option) => (
                <MenuRadioItem key={option} value={option}>
                  {CAPABILITY_MODE_LABELS[option]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          ) : null}
          <p className="text-muted-foreground text-xs">{CAPABILITY_MODE_DESCRIPTIONS[mode]}</p>
          {threadRef !== null ? (
            <>
              <MenuItem
                disabled={change.disabledReason !== null}
                onClick={() => void setThreadCapabilityMode(threadRef, change.target)}
              >
                {change.label}
              </MenuItem>
              {change.disabledReason !== null ? (
                <p className="text-muted-foreground text-xs">{change.disabledReason}</p>
              ) : null}
            </>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
