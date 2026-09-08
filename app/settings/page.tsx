import { Settings } from "lucide-react";

import { SettingsForm } from "@/features/settings/components/SettingsForm";

export const metadata = { title: "Settings — SpotLens" };

export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Settings className="h-5 w-5" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">Defaults that follow you across sessions.</p>
      </header>

      <SettingsForm />
    </div>
  );
}
