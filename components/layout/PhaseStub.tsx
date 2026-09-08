import type { LucideIcon } from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PhaseStubProps {
  title: string;
  icon: LucideIcon;
  summary: string;
  /** What this page will do once its phase ships. */
  planned: string[];
}

/**
 * Placeholder for a nav destination whose phase has not shipped yet. The
 * information architecture is final from Phase 1, so these routes exist and are
 * honest about what is not built rather than 404ing.
 */
export function PhaseStub({ title, icon: Icon, summary, planned }: PhaseStubProps) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Icon className="h-5 w-5" />
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>This page will include:</p>
          <ul className="list-disc space-y-1 pl-5">
            {planned.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            In the meantime,{" "}
            <Link href="/market-analysis" className="text-primary underline underline-offset-2">
              open a chart
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
