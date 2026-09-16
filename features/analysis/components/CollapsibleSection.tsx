"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A titled section that can be folded away.
 *
 * Distinct from `WhyDisclosure`, which hides a sentence behind the word "Why?".
 * This hides a whole block behind its own heading, and keeps the heading
 * readable while closed — which is what lets the secondary half of the page be
 * present without being in the way.
 *
 * The button is the heading, so a screen reader announces the level and the
 * expanded state together, and `aria-controls` points at the region it opens.
 * Keyboard users get it for free: it is a real button, not a div with a click
 * handler.
 */
export function CollapsibleSection({
  title,
  summary,
  icon,
  iconLabel,
  badge,
  defaultOpen = false,
  children,
  className,
  headingLevel = 3,
}: {
  title: string;
  /** One line, visible whether or not the section is open. */
  summary?: React.ReactNode;
  icon?: React.ReactNode;
  /**
   * What the icon means, for a screen reader.
   *
   * Rendered after the title rather than before it: the icon is drawn to the
   * left, but announcing "Neither way: Trend" puts the qualifier ahead of the
   * thing it qualifies, which is the wrong way round to listen to. Sighted
   * readers get the icon; everyone else gets "Trend, neither way".
   */
  iconLabel?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  headingLevel?: 2 | 3 | 4;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";

  return (
    <section className={cn("border-b border-border/60 last:border-b-0", className)}>
      <Heading className="m-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id}
          // 44px minimum touch target, which is the whole reason for py-2.5
          // rather than the tighter padding the rest of the panel uses.
          className="flex w-full items-start gap-2 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <ChevronRight
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
          {icon ? (
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-semibold">
                {title}
                {iconLabel ? <span className="sr-only">, {iconLabel}</span> : null}
              </span>
              {badge}
            </span>
            {summary ? (
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {summary}
              </span>
            ) : null}
          </span>
        </button>
      </Heading>

      <div id={id} hidden={!open} className="pb-3 pl-[22px] pr-1">
        {children}
      </div>
    </section>
  );
}
