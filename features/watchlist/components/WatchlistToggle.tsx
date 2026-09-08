"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useSession } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { cn } from "@/lib/utils";
import type { MarketSummary } from "@/types/market";

interface WatchlistItem {
  id: string;
  market: MarketSummary;
}

/** Saves the current pair. Hidden entirely when signed out — an always-visible
 *  control that only ever tells you to log in is noise on a chart. */
export function WatchlistToggle({ pairId }: { pairId?: string }) {
  const { status } = useSession();
  const queryClient = useQueryClient();

  const query = useQuery<{ items: WatchlistItem[] }>({
    queryKey: ["watchlist"],
    queryFn: () => fetchApi("/api/watchlist"),
    enabled: status === "authenticated",
  });

  const entry = query.data?.items.find((item) => item.market.pairId === pairId);

  const toggle = useMutation({
    mutationFn: async () => {
      if (entry) {
        return fetchApi(`/api/watchlist/${entry.id}`, { method: "DELETE" });
      }
      return fetchApi("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradingPairId: pairId }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  if (status !== "authenticated" || !pairId) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      aria-pressed={Boolean(entry)}
      aria-label={entry ? "Remove from watchlist" : "Add to watchlist"}
    >
      <Star className={cn("h-4 w-4", entry && "fill-current text-amber-500")} />
      {entry ? "Saved" : "Watch"}
    </Button>
  );
}
