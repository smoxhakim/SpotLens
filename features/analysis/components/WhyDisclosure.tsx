"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The "Why?" affordance behind every number in the product.
 *
 * A result the user cannot interrogate is a signal, not an analysis — the whole
 * wedge is that the reasoning is always one click away.
 */
export function WhyDisclosure({
  children,
  label = "Why?",
}: {
  children: React.ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      <div
        id={id}
        hidden={!open}
        className="mt-1 text-[11px] leading-relaxed text-muted-foreground"
      >
        {children}
      </div>
    </div>
  );
}
