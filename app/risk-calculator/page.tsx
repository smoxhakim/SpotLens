import { Calculator } from "lucide-react";

import { PhaseStub } from "@/components/layout/PhaseStub";

export const metadata = { title: "Risk Calculator — SpotLens" };

export default function RiskCalculatorPage() {
  return (
    <PhaseStub
      title="Risk Calculator"
      icon={Calculator}
      summary="Size a position from your balance, your risk limit, and the stop distance."
      planned={[
        "Position size from portfolio balance and maximum risk per trade",
        "Configurable default risk percentage",
        "Wired to the entry and stop loss of an analysis result",
      ]}
    />
  );
}
