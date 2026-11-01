import { createFileRoute } from "@tanstack/react-router";

import { RemotePage } from "../components/remote/RemotePage";

export const Route = createFileRoute("/remote")({
  component: RemotePage,
});
