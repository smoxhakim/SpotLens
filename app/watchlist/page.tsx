import { Eye } from "lucide-react";

import { PhaseStub } from "@/components/layout/PhaseStub";

export const metadata = { title: "Watchlist — SpotLens" };

export default function WatchlistPage() {
  return (
    <PhaseStub
      title="Watchlist"
      icon={Eye}
      summary="Save the pairs you follow and jump straight to their charts."
      planned={[
        "Save any curated asset/pair combination to your account",
        "Quick access from the sidebar",
        "Requires accounts, which arrive with authentication",
      ]}
    />
  );
}
