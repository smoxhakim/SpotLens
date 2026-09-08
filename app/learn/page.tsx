import { BookOpen } from "lucide-react";

import { PhaseStub } from "@/components/layout/PhaseStub";

export const metadata = { title: "Learn — SpotLens" };

export default function LearnPage() {
  return (
    <PhaseStub
      title="Learn"
      icon={BookOpen}
      summary="Plain-language explanations of every concept the analysis uses."
      planned={[
        "Glossary: support, resistance, market structure, RSI, risk/reward",
        "Contextual links from each field of an analysis result",
        "Per-asset research pages, including the ethical research checklist",
      ]}
    />
  );
}
