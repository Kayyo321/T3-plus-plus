import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, WorkspaceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { makeSecretMask } from "@t3tools/shared/secretRedaction";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import * as WorkspaceProcessEnvironment from "../../workspace/WorkspaceProcessEnvironment.ts";
import { ClaudeOrchestratorReplayHarness } from "../Adapters/ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { commandOutputStreamingInput } from "./fixtures/command_output_streaming/input.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

// A real provider transcript: Claude prints this line through a shell command, live and final.
const PRINTED_SECRET = "stream line 2";

it.effect("keeps a value a provider prints out of every event, projection and client stream", () =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("claudeAgent");
    const raw = yield* readProviderReplayTranscript(
      new URL("./fixtures/command_output_streaming/claude_transcript.ndjson", import.meta.url),
    ).pipe(Effect.provide(NodeServices.layer));
    const transcript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
      materializeReplayTranscriptRuntimeInstructions(raw, {
        driver,
        model: CLAUDE_MODEL_SELECTION.model,
      }),
    );
    const materialized = yield* materializeFixtureInput({
      scenario: "command_output_streaming",
      fixtureInput: commandOutputStreamingInput(),
      driver,
      modelSelection: CLAUDE_MODEL_SELECTION,
    }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);

    const result = yield* runOrchestratorV2ProviderReplayScenario(
      {
        name: "workspace-secrets/claudeAgent",
        transcript,
        commands: materialized.commands,
        steps: materialized.steps,
        projectionThreadIds: materialized.projectionThreadIds,
      },
      ClaudeOrchestratorReplayHarness,
    ).pipe(
      Effect.provideService(WorkspaceProcessEnvironment.WorkspaceProcessEnvironment, {
        forThread: () =>
          Effect.succeedSome({
            workspaceId: WorkspaceId.make("workspace-replay"),
            workspaceName: "staging",
            workingRoot: null,
            environment: Redacted.make({ PROBE: PRINTED_SECRET }),
            secretNames: ["PROBE"],
            mask: makeSecretMask([{ name: "PROBE", value: PRINTED_SECRET }]),
            settings: {},
            fingerprint: "replay",
          }),
      }),
    );

    const persisted = JSON.stringify({
      events: result.storedEvents,
      projections: [...result.projections.values()],
      shell: result.shellSnapshot,
    });
    assert.notInclude(persisted, PRINTED_SECRET);
    assert.include(persisted, "stream line 1", "the run really did print this output");
    assert.include(persisted, "[secret:PROBE]");

    const live = JSON.stringify([...(result.commandOutput?.values() ?? [])]);
    assert.notInclude(live, PRINTED_SECRET);
  }),
);
