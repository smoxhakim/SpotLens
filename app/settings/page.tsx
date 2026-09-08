import { Settings } from "lucide-react";

import { PhaseStub } from "@/components/layout/PhaseStub";

export const metadata = { title: "Settings — SpotLens" };

export default function SettingsPage() {
  return (
    <PhaseStub
      title="Settings"
      icon={Settings}
      summary="Defaults that follow you across sessions."
      planned={[
        "Default risk percentage per trade",
        "Default timeframe",
        "Requires accounts, which arrive with authentication",
      ]}
    />
  );
}
