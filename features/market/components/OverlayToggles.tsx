"use client";

import { cn } from "@/lib/utils";

export interface OverlayState {
  ema20: boolean;
  ema50: boolean;
  ema200: boolean;
  zones: boolean;
}

const ITEMS: { key: keyof OverlayState; label: string; color?: string }[] = [
  { key: "ema20", label: "EMA 20", color: "#38bdf8" },
  { key: "ema50", label: "EMA 50", color: "#f59e0b" },
  { key: "ema200", label: "EMA 200", color: "#a78bfa" },
  { key: "zones", label: "S/R zones" },
];

export function OverlayToggles({
  value,
  onChange,
}: {
  value: OverlayState;
  onChange: (next: OverlayState) => void;
}) {
  return (
    <div role="group" aria-label="Chart overlays" className="flex flex-wrap items-center gap-1">
      {ITEMS.map((item) => {
        const active = value[item.key];
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange({ ...value, [item.key]: !active })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
              active
                ? "border-input bg-accent text-accent-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/50",
            )}
          >
            {item.color && (
              <span
                aria-hidden
                className="h-0.5 w-3 rounded-full"
                style={{ backgroundColor: active ? item.color : "currentColor" }}
              />
            )}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
