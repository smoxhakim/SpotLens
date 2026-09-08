"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { MarketSummary } from "@/types/market";

interface WatchlistItem {
  id: string;
  createdAt: string;
  market: MarketSummary;
}

export function WatchlistView() {
  const { status } = useSession();
  const queryClient = useQueryClient();

  const query = useQuery<{ items: WatchlistItem[] }>({
    queryKey: ["watchlist"],
    queryFn: () => fetchApi("/api/watchlist"),
    enabled: status === "authenticated",
  });

  const remove = useMutation({
    mutationFn: (id: string) => fetchApi(`/api/watchlist/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["watchlist"] }),
  });

  if (status === "loading") return <Skeleton className="h-40 w-full" />;

  if (status !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Your watchlist is saved to your account.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (query.isPending) return <Skeleton className="h-40 w-full" />;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(query.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const items = query.data?.items ?? [];

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <Eye className="mx-auto mb-2 h-5 w-5" />
          <p>Nothing saved yet. Open a chart and use “Add to watchlist”.</p>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link href="/market-analysis">Browse markets</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Saved pairs</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2">
              <Link
                href={`/market-analysis?pair=${item.market.exchangeSymbol}&tf=H4`}
                className="min-w-0 flex-1"
              >
                <div className="text-sm font-medium">{item.market.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.market.asset.name}
                </div>
              </Link>
              <Badge variant="outline" className="text-[10px]">
                {item.market.asset.category.replace(/_/g, " ").toLowerCase()}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${item.market.label} from watchlist`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(item.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
