import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowUpIcon, CheckIcon, FolderIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { filesystemEnvironment } from "../../state/filesystem";
import { useEnvironmentQuery } from "../../state/query";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Browses the environment's disk, not this device's, so it works over any connection. */
export function WorkspaceFolderPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly added: ReadonlyArray<string>;
  readonly onAdd: (folder: string) => void;
}) {
  const [query, setQuery] = useState("~/");
  const { presentation } = useEnvironmentPresentation(props.environmentId);
  const platform = getEnvironmentBrowsePlatform(
    presentation?.serverConfig?.environment.platform.os,
  );
  const { isBrowsing, directoryPath, filterQuery, parentPath, canBrowseUp } =
    getFilesystemBrowsePath(query, platform);
  const browse = useEnvironmentQuery(
    isBrowsing
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: directoryPath },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browse.data?.entries ?? [],
    filterQuery,
  );
  const target = exactEntry?.fullPath ?? (filterQuery === "" ? browse.data?.parentPath : undefined);
  const addable = target !== undefined && !props.added.includes(target);
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-1.5">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Up one folder"
          disabled={!canBrowseUp || parentPath === null}
          onClick={() => {
            if (parentPath !== null) setQuery(ensureBrowseDirectoryPath(parentPath));
          }}
        >
          <ArrowUpIcon aria-hidden />
        </Button>
        <Input
          aria-label="Search for a folder"
          value={query}
          placeholder="~/projects"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter belongs to the picker here: the dialog's form must not save.
            event.preventDefault();
            if (addable) props.onAdd(target);
          }}
        />
      </div>
      <div className="flex max-h-40 flex-col overflow-y-auto">
        {visibleEntries.map((entry) => {
          const added = props.added.includes(entry.fullPath);
          return (
            <div key={entry.fullPath} className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent"
                onClick={() => setQuery(ensureBrowseDirectoryPath(entry.fullPath))}
              >
                <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={added ? `${entry.name} is added` : `Add ${entry.name}`}
                disabled={added}
                onClick={() => props.onAdd(entry.fullPath)}
              >
                {added ? <CheckIcon aria-hidden /> : <PlusIcon aria-hidden />}
              </Button>
            </div>
          );
        })}
        {visibleEntries.length === 0 ? (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">
            {browse.isPending
              ? "Looking…"
              : (browse.error ?? (isBrowsing ? "No folders here." : "Start with / or ~/"))}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={!addable}
        onClick={() => {
          if (addable) props.onAdd(target);
        }}
      >
        <span className="truncate">
          {target === undefined ? "Add this folder" : `Add ${target}`}
        </span>
      </Button>
    </div>
  );
}
