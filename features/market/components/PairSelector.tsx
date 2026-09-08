"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MarketSummary } from "@/types/market";

interface PairSelectorProps {
  markets: MarketSummary[];
  value?: MarketSummary;
  onChange: (market: MarketSummary) => void;
  disabled?: boolean;
}

/**
 * Searchable pair picker. The curated list runs to ~45 entries, so a plain
 * select is unusable but a full combobox library would be overkill.
 */
export function PairSelector({ markets, value, onChange, disabled }: PairSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.asset.name.toLowerCase().includes(q) ||
        m.asset.symbol.toLowerCase().includes(q),
    );
  }, [markets, query]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select trading pair"
        className="flex h-9 min-w-[150px] items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent/50 focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      >
        <span>{value?.label ?? "Select pair"}</span>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-80 max-w-[85vw] overflow-hidden rounded-md border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search assets…"
              aria-label="Search assets"
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul role="listbox" className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                No curated asset matches “{query}”.
              </li>
            )}
            {filtered.map((market) => {
              const selected = market.pairId === value?.pairId;
              return (
                <li key={market.pairId}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(market);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                      selected && "bg-accent",
                    )}
                  >
                    <Check className={cn("h-3.5 w-3.5", selected ? "opacity-100" : "opacity-0")} />
                    <span className="font-medium">{market.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {market.asset.name}
                    </span>
                    <Badge variant="outline" className="ml-auto shrink-0 text-[10px]">
                      {market.asset.category.replace(/_/g, " ").toLowerCase()}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
