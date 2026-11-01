import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import { CornerDownRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";

/** A nested session's rows sit directly under the parent's, whatever folder that is in. */
export function SidebarNestedSessionRows(props: {
  readonly nested: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  readonly parent: EnvironmentThreadShell;
  readonly activeThreadKey: string | null;
  readonly depth?: number;
}) {
  const depth = props.depth ?? 1;
  const children = props.nested.get(props.parent.id);
  if (children === undefined) return null;
  return (
    <>
      {children.map((child) => {
        const ref = scopeThreadRef(child.environmentId, child.id);
        const key = scopedThreadKey(ref);
        return (
          <div key={key} className="contents">
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(ref)}
              style={{ paddingInlineStart: `${depth * 0.75 + 0.5}rem` }}
              aria-current={key === props.activeThreadKey ? "page" : undefined}
              className={cn(
                "flex h-6 min-w-0 items-center gap-1.5 rounded-md pe-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                key === props.activeThreadKey && "bg-accent text-foreground",
              )}
            >
              <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{child.title}</span>
            </Link>
            <SidebarNestedSessionRows
              nested={props.nested}
              parent={child}
              activeThreadKey={props.activeThreadKey}
              depth={depth + 1}
            />
          </div>
        );
      })}
    </>
  );
}
