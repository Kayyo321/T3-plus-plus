import type { ScopedThreadRef, TeamSheetId } from "@t3tools/contracts";

import { useRightPanelStore } from "../../rightPanelStore";

export function openTeamSheetEditor(threadRef: ScopedThreadRef, sheetId: TeamSheetId): void {
  useRightPanelStore.getState().openTeamSheet(threadRef, sheetId);
}
