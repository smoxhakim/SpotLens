"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import {
  toneForNotification,
  type NotificationEventType,
  type NotificationPriority,
  type NotificationTone,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

interface NotificationRow {
  id: string;
  type: NotificationEventType;
  priority: NotificationPriority;
  title: string;
  body: string;
  asset: string | null;
  timeframe: Timeframe | null;
  trackedSetupId: string | null;
  read: boolean;
  createdAt: string;
}

/**
 * Presentation only — which tone a row carries is decided in `lib/notifications`.
 *
 * Keyed by tone rather than by event type, because the two are not the same
 * thing: a re-anchored setup and a failed one are both `SETUP_INVALIDATED`, and
 * colouring a piece of bookkeeping in the failure colour tells the reader a
 * level broke when none did.
 */
const TONE_CLASS: Record<NotificationTone, string> = {
  POSITIVE: "text-bullish",
  INFO: "text-sky-600 dark:text-sky-400",
  NEGATIVE: "text-bearish",
  WARNING: "text-amber-600 dark:text-amber-400",
  NEUTRAL: "text-muted-foreground",
};

export function NotificationList() {
  const { status: authStatus } = useSession();
  const queryClient = useQueryClient();

  const query = useQuery<{ notifications: NotificationRow[]; unread: number }>({
    queryKey: ["notifications"],
    queryFn: () => fetchApi("/api/notifications?limit=50"),
    enabled: authStatus === "authenticated",
  });

  const markAll = useMutation({
    mutationFn: () => fetchApi("/api/notifications/read-all", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const markOne = useMutation({
    mutationFn: (id: string) => fetchApi(`/api/notifications/${id}/read`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (authStatus === "loading") return <Skeleton className="h-40 w-full" />;

  if (authStatus !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Notifications are kept with your account.</p>
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

  const notifications = query.data?.notifications ?? [];
  const unread = query.data?.unread ?? 0;

  if (notifications.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
          <p>Nothing yet.</p>
          <p className="text-[11px] leading-relaxed">
            Notifications come from the scanner as it tracks setups. Start it with{" "}
            <code>npm run scanner</code>, and choose which events you want in Settings — by default
            only confirmations, invalidations and scanner errors are on.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Bell className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {unread} unread of {notifications.length}
        </span>
        {unread > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </Button>
        )}
      </div>

      <ul className="space-y-2">
        {notifications.map((n) => (
          <li key={n.id}>
            <Card className={cn(!n.read && "border-primary/40")}>
              <CardContent className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className={cn("text-xs font-semibold", TONE_CLASS[toneForNotification(n)])}>
                    {n.title}
                  </span>
                  {!n.read && (
                    <Badge variant="outline" className="text-[9px]">
                      new
                    </Badge>
                  )}
                  {n.timeframe && (
                    <span className="text-[10px] text-muted-foreground">
                      {TIMEFRAME_LABELS[n.timeframe]}
                    </span>
                  )}
                  {/* Stored UTC, shown in the reader's own zone. */}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>

                <p className="text-[11px] leading-relaxed text-muted-foreground">{n.body}</p>

                <div className="flex items-center gap-2 pt-0.5">
                  {n.asset && (
                    <Button asChild size="sm" variant="ghost" className="h-6 px-2 text-[10px]">
                      <Link href={`/market-analysis?pair=${n.asset}`}>Open chart</Link>
                    </Button>
                  )}
                  {!n.read && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => markOne.mutate(n.id)}
                    >
                      Mark read
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
