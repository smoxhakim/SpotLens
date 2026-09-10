"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";

interface MeResponse {
  user: { email: string; defaultRiskPercent: number; defaultTimeframe: Timeframe } | null;
}

export function SettingsForm() {
  const { status } = useSession();
  const queryClient = useQueryClient();

  const me = useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: () => fetchApi("/api/user/me"),
    enabled: status === "authenticated",
  });

  // The saved settings are the source of truth; local state holds only what the
  // user has edited since. Copying the query into state from an effect instead
  // would write state during a render pass and briefly show the defaults.
  const [edited, setEdited] = useState<{ riskPercent?: string; timeframe?: Timeframe }>({});

  const riskPercent =
    edited.riskPercent ?? (me.data?.user ? String(me.data.user.defaultRiskPercent) : "1");
  const timeframe = edited.timeframe ?? me.data?.user?.defaultTimeframe ?? "H1";

  const save = useMutation({
    mutationFn: () =>
      fetchApi("/api/user/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultRiskPercent: Number(riskPercent),
          defaultTimeframe: timeframe,
        }),
      }),
    onSuccess: () => {
      // Saved values are now the server's, so drop the local edits and let the
      // refetched settings drive the form again.
      setEdited({});
      return queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });

  if (status === "loading") return <Skeleton className="h-48 w-full" />;

  if (status !== "authenticated") {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p>Settings are saved to your account.</p>
          <Button asChild size="sm" className="mt-3">
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (me.isPending) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Defaults</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="risk">Default risk per trade (%)</Label>
          <Input
            id="risk"
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            value={riskPercent}
            onChange={(e) => setEdited((prev) => ({ ...prev, riskPercent: e.target.value }))}
            className="max-w-[140px]"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Used by the risk calculator. Capped at 10% — beyond that a short losing streak takes the
            account with it, and a tool about risk management should not help you set it.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="timeframe">Default timeframe</Label>
          <select
            id="timeframe"
            value={timeframe}
            onChange={(e) =>
              setEdited((prev) => ({ ...prev, timeframe: e.target.value as Timeframe }))
            }
            className="flex h-9 max-w-[140px] rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {TIMEFRAME_LABELS[tf]}
              </option>
            ))}
          </select>
        </div>

        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{(save.error as Error).message}</AlertDescription>
          </Alert>
        )}
        {save.isSuccess && (
          <Alert variant="muted">
            <AlertDescription>Settings saved.</AlertDescription>
          </Alert>
        )}

        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
      </CardContent>
    </Card>
  );
}
