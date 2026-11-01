import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ComputerUseStep, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  computerUseStepMeta,
  computerUseStepTitle,
  olderStepsCursor,
} from "./computerUsePresentation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type ComputerUseTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function StepScreenshot(props: ComputerUseTarget & { readonly stepId: string }) {
  const { environmentId, threadId, stepId } = props;
  const screenshot = useEnvironmentQuery(
    serverEnvironment.computerUseScreenshot({ environmentId, input: { threadId, stepId } }),
  );
  if (screenshot.error !== null) {
    return <Text className="text-xs text-foreground-muted">Screenshot no longer available.</Text>;
  }
  if (screenshot.data === null) {
    return (
      <View className="h-24 items-center justify-center">
        <AppActivityIndicator colorClassName="accent-foreground-muted" />
      </View>
    );
  }
  return (
    <Image
      accessibilityLabel="Screenshot of this step"
      source={{ uri: `data:${screenshot.data.mimeType};base64,${screenshot.data.data}` }}
      contentFit="contain"
      style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 12 }}
    />
  );
}

function StepRow(
  props: ComputerUseTarget & {
    readonly step: ComputerUseStep;
    readonly open: boolean;
    readonly onToggle: () => void;
  },
) {
  const { step } = props;
  return (
    <View className="gap-2 border-b border-border py-3">
      <Text className="font-t3-medium text-sm text-foreground">{computerUseStepTitle(step)}</Text>
      <Text className="text-xs text-foreground-muted">
        {computerUseStepMeta(step)} · <RelativeTime timestamp={step.at} />
      </Text>
      {step.result ? (
        <Text className="text-xs text-foreground-secondary" numberOfLines={4}>
          {step.result}
        </Text>
      ) : null}
      {step.hasScreenshot ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.open }}
          onPress={props.onToggle}
          className="self-start active:opacity-70"
        >
          <Text className="font-t3-medium text-xs text-primary-text">
            {props.open ? "Hide screenshot" : "Show screenshot"}
          </Text>
        </Pressable>
      ) : null}
      {props.open ? (
        <StepScreenshot
          environmentId={props.environmentId}
          threadId={props.threadId}
          stepId={step.id}
        />
      ) : null}
    </View>
  );
}

function StepRows(
  props: ComputerUseTarget & {
    readonly steps: ReadonlyArray<ComputerUseStep>;
    readonly openStepId: string | null;
    readonly onToggle: (stepId: string) => void;
  },
) {
  return props.steps.map((step) => (
    <StepRow
      key={step.id}
      environmentId={props.environmentId}
      threadId={props.threadId}
      step={step}
      open={props.openStepId === step.id}
      onToggle={() => props.onToggle(step.id)}
    />
  ));
}

/** Each page reveals the next on request, so a long session costs nothing until someone asks. */
function OlderSteps(
  props: ComputerUseTarget & {
    readonly beforeSequence: number;
    readonly openStepId: string | null;
    readonly onToggle: (stepId: string) => void;
  },
) {
  const { environmentId, threadId, beforeSequence } = props;
  const [showNext, setShowNext] = useState(false);
  const page = useEnvironmentQuery(
    serverEnvironment.computerUseSteps({ environmentId, input: { threadId, beforeSequence } }),
  );
  if (page.error !== null) {
    return <Text className="py-3 text-sm text-danger-foreground">{page.error}</Text>;
  }
  if (page.data === null) {
    return (
      <View className="py-4">
        <AppActivityIndicator colorClassName="accent-foreground-muted" />
      </View>
    );
  }
  const nextCursor = olderStepsCursor(page.data.steps);
  return (
    <>
      <StepRows
        environmentId={environmentId}
        threadId={threadId}
        steps={page.data.steps}
        openStepId={props.openStepId}
        onToggle={props.onToggle}
      />
      {!page.data.hasMore || nextCursor === null ? null : showNext ? (
        <OlderSteps
          environmentId={environmentId}
          threadId={threadId}
          beforeSequence={nextCursor}
          openStepId={props.openStepId}
          onToggle={props.onToggle}
        />
      ) : (
        <View className="pt-3">
          <Button label="Show older steps" onPress={() => setShowNext(true)} />
        </View>
      )}
    </>
  );
}

export function ThreadComputerUseSheet({ route }: StaticScreenProps<ComputerUseTarget>) {
  const { environmentId, threadId } = route.params;
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const live = useEnvironmentQuery(
    serverEnvironment.computerUseLive({ environmentId, input: { threadId } }),
  );
  // One at a time: a screenshot is a large payload to hold in memory on a phone.
  const [openStepId, setOpenStepId] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState<number | null>(null);
  const toggle = (stepId: string) =>
    setOpenStepId((current) => (current === stepId ? null : stepId));
  const steps = live.data?.recentSteps ?? [];
  const cursor = olderStepsCursor(steps);
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {live.data === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          {live.error ?? "Loading steps…"}
        </Text>
      ) : steps.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">No steps yet.</Text>
      ) : (
        <StepRows
          environmentId={environmentId}
          threadId={threadId}
          steps={steps}
          openStepId={openStepId}
          onToggle={toggle}
        />
      )}
      {showOlder !== null ? (
        <OlderSteps
          environmentId={environmentId}
          threadId={threadId}
          beforeSequence={showOlder}
          openStepId={openStepId}
          onToggle={toggle}
        />
      ) : cursor !== null && steps.length > 0 ? (
        <View className="pt-3">
          <Button label="Show older steps" onPress={() => setShowOlder(cursor)} />
        </View>
      ) : null}
    </ScrollView>
  );
  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-computer-use-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Computer use"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Computer use" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
