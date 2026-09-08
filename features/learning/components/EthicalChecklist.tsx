import { CircleHelp, CircleSlash, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ETHICAL_CHECKLIST_DISCLAIMER } from "@/lib/constants/disclaimers";
import type { ChecklistAnswer, EthicalChecklistSeed } from "@/lib/ethics/checklist";
import { cn } from "@/lib/utils";

const ANSWER_META: Record<
  ChecklistAnswer,
  { label: string; className: string; Icon: typeof CircleHelp }
> = {
  YES: {
    label: "Yes",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    Icon: TriangleAlert,
  },
  NO: {
    label: "No",
    className: "border-border bg-muted/40 text-muted-foreground",
    Icon: CircleSlash,
  },
  UNCLEAR: {
    label: "Unclear",
    className: "border-border bg-muted/40 text-muted-foreground",
    Icon: CircleHelp,
  },
};

/**
 * Research questions about a project, with the answer and the reasoning.
 *
 * Presented as questions to investigate, never as a verdict. "Yes" is styled as
 * something to look into rather than as a failure, because the checklist does
 * not rule on anything — that is what the disclaimer says and the design has to
 * match it.
 */
export function EthicalChecklist({ checklist }: { checklist: EthicalChecklistSeed }) {
  const questions = [
    {
      question: "Does the project involve lending with interest?",
      answer: checklist.involvesInterestLending,
      note: checklist.involvesInterestLendingNote,
    },
    {
      question: "Does the project directly support gambling?",
      answer: checklist.supportsGambling,
      note: checklist.supportsGamblingNote,
    },
    {
      question: "Does the project directly support prohibited industries?",
      answer: checklist.supportsProhibitedIndustries,
      note: checklist.supportsProhibitedNote,
    },
    {
      question: "Does the token have clear utility?",
      answer: checklist.hasClearUtility,
      note: checklist.hasClearUtilityNote,
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle as="h2">Ethical / Shariah research checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant="warning">
          <AlertDescription>{ETHICAL_CHECKLIST_DISCLAIMER}</AlertDescription>
        </Alert>

        <section>
          <Label>What does the project do?</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {checklist.whatProjectDoes}
          </p>
        </section>

        <section>
          <Label>What is the token used for?</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">{checklist.tokenUtility}</p>
        </section>

        <ul className="space-y-3">
          {questions.map(({ question, answer, note }) => {
            const meta = ANSWER_META[answer];
            const { Icon } = meta;
            return (
              <li key={question} className="rounded-md border p-3">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                      meta.className,
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                  <span className="text-xs font-medium">{question}</span>
                </div>
                {note && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
                )}
              </li>
            );
          })}
        </ul>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          These answers describe the project and its token as documented publicly. They are starting
          points for your own research, not conclusions — and an answer of “yes” is a question to
          look into, not a verdict.
        </p>
      </CardContent>
    </Card>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}
