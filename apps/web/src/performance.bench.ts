import { ProjectId } from "@t3tools/contracts";
import {
  getLatestThreadForProject,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { formatHourShort, formatRelativeHourShort } from "@t3tools/shared/usageFormat";
import { describe, test } from "vite-plus/test";

import { BUILT_IN_LAYOUTS, flattenLayout } from "./layouts/layoutDocument";
import { deriveEditReview } from "./components/files/agentEditReview";
import { resolveExpandedPaneIds } from "./layouts/splitView.logic";

const projectId = ProjectId.make("benchmark-project");
const start = Date.parse("2026-08-11T00:00:00.000Z");
const threads = Array.from({ length: 1_000 }, (_, index) => {
  const timestamp = new Date(start + ((index * 997) % 1_000) * 60_000).toISOString();
  return {
    id: `thread-${index}`,
    projectId,
    archivedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    latestUserMessageAt: timestamp,
    unsettledAt: null,
  };
});
const hours = Array.from({ length: 24 }, (_, index) =>
  new Date(start + index * 3_600_000).toISOString(),
);
const referenceTime = "2026-08-12T00:00:00.000Z";
const ideLayout = BUILT_IN_LAYOUTS.find((layout) => layout.id === "ide")!;
const fourPanes = {
  panes: ["a", "b", "c", "d"].map((id) => ({ id, target: null })),
  focusedPaneId: "c",
};
const editorFile = Array.from({ length: 2_000 }, (_, line) => `const line${line} = ${line};\n`);
const editorBaseline = editorFile.join("");
const editorEdited = editorFile
  .map((line, index) => (index % 200 === 0 ? `// changed ${index}\n${line}` : line))
  .join("");

describe("client performance", () => {
  test("flatten the IDE layout for one resize frame", async ({ bench }) => {
    await bench("flatten", () => {
      flattenLayout(ideLayout.root);
    }).run();
  });
  test("resolve which of four split panes render at a width", async ({ bench }) => {
    await bench("resolve", () => {
      resolveExpandedPaneIds(fourPanes, 1_100);
    }).run();
  });
  test("review a 2000 line file with ten agent hunks", async ({ bench }) => {
    await bench("review", () => {
      deriveEditReview("src/file.ts", editorBaseline, editorEdited);
    }).run();
  });
  test("sort 1000 threads by recent activity", async ({ bench }) => {
    await bench("sort", () => {
      sortThreads(threads, "updated_at");
    }).run();
  });
  test("sort 1000 active threads", async ({ bench }) => {
    await bench("sort", () => {
      sortActiveThreadsByOrderKey(threads);
    }).run();
  });
  test("sort 1000 keyless pinned threads", async ({ bench }) => {
    await bench("sort", () => {
      sortPinnedThreadsByOrderKey(threads);
    }).run();
  });
  test("select latest project thread from 1000 threads", async ({ bench }) => {
    await bench("select", () => {
      getLatestThreadForProject(threads, projectId, "updated_at");
    }).run();
  });
  test("format 24 hourly usage labels and tooltips", async ({ bench }) => {
    await bench("format", () => {
      hours.map((hour) => [
        formatHourShort(hour, "America/New_York"),
        formatRelativeHourShort(hour, referenceTime, "America/New_York"),
      ]);
    }).run();
  });
});
