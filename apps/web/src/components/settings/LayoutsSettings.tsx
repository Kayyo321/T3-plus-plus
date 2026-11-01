import type { ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { type LayoutDocument } from "../../layouts/layoutDocument";
import { resolveDefaultLayout, selectLayouts, useLayoutStore } from "../../layouts/layoutStore";
import { useProjects } from "../../state/entities";
import { SaveLayoutDialog } from "../layouts/SaveLayoutDialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const FOLLOW_FAVORITE = "follow-favorite";

export function LayoutsSettings() {
  const saved = useLayoutStore((state) => state.saved);
  const favoriteId = useLayoutStore((state) => state.favoriteId);
  const projectLayoutIds = useLayoutStore((state) => state.projectLayoutIds);
  const projects = useProjects();
  const [renaming, setRenaming] = useState<LayoutDocument | null>(null);
  const layouts = selectLayouts({ saved });
  const defaultLayout = resolveDefaultLayout({ saved, favoriteId, projectLayoutIds: {} }, null);
  const overriddenProjects = Object.keys(projectLayoutIds).length;
  const layoutItems = layouts.map((layout) => (
    <SelectItem key={layout.id} value={layout.id}>
      {layout.name}
    </SelectItem>
  ));
  const nameOf = (id: string | null) => layouts.find((layout) => layout.id === id)?.name ?? null;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Defaults">
        <SettingsRow
          title="New conversations"
          description="The layout every new conversation opens in. Saved on this device."
          control={
            <Select
              value={defaultLayout.id}
              onValueChange={(value) => useLayoutStore.getState().setFavorite(value)}
            >
              <SelectTrigger aria-label="Default layout" className="w-40">
                <SelectValue>{defaultLayout.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup>{layoutItems}</SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Reset to default"
          description={
            overriddenProjects > 0
              ? `Back to Focus, and clears ${overriddenProjects} project ${overriddenProjects === 1 ? "override" : "overrides"}.`
              : "Back to Focus for every new conversation."
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={favoriteId === null && overriddenProjects === 0}
              onClick={() => useLayoutStore.getState().resetDefaults()}
            >
              Reset
            </Button>
          }
        />
      </SettingsSection>
      {projects.length > 0 ? (
        <SettingsSection title="Projects">
          {projects.map((project) => {
            const projectId: ProjectId = project.id;
            const value = projectLayoutIds[projectId] ?? FOLLOW_FAVORITE;
            return (
              <SettingsRow
                key={`${project.environmentId}:${project.id}`}
                title={project.title}
                control={
                  <Select
                    value={value}
                    onValueChange={(next) =>
                      useLayoutStore
                        .getState()
                        .setProjectLayout(projectId, next === FOLLOW_FAVORITE ? null : next)
                    }
                  >
                    <SelectTrigger aria-label={`Layout for ${project.title}`} className="w-40">
                      <SelectValue>{nameOf(value) ?? "Use default"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={FOLLOW_FAVORITE}>Use default</SelectItem>
                      {layoutItems}
                    </SelectPopup>
                  </Select>
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Saved layouts">
        {saved.length === 0 ? (
          <SettingsRow
            title="No saved layouts"
            description="Arrange the panels, then choose Save current layout from the layouts menu."
          />
        ) : null}
        {saved.map((layout) => (
          <SettingsRow
            key={layout.id}
            title={layout.name}
            control={
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setRenaming(layout)}>
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => useLayoutStore.getState().remove(layout.id)}
                >
                  Delete
                </Button>
              </div>
            }
          />
        ))}
      </SettingsSection>
      <SaveLayoutDialog
        open={renaming !== null}
        title="Rename layout"
        {...(renaming ? { initialName: renaming.name } : {})}
        onClose={() => setRenaming(null)}
        onSave={(name) => {
          if (renaming) useLayoutStore.getState().rename(renaming.id, name);
        }}
      />
    </SettingsPageContainer>
  );
}
