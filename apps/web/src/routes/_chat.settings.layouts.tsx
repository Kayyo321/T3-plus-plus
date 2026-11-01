import { createFileRoute } from "@tanstack/react-router";

import { LayoutsSettings } from "../components/settings/LayoutsSettings";

function SettingsLayoutsRoute() {
  return <LayoutsSettings />;
}

export const Route = createFileRoute("/_chat/settings/layouts")({
  component: SettingsLayoutsRoute,
});
