"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { NotificationPreferences } from "@/lib/notifications";

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  chatLabel: string | null;
  connectedAt: string | null;
  pending: boolean;
}

/**
 * Each toggle names the event and says plainly how often it fires, because
 * "how noisy is this?" is the only question that matters when choosing.
 */
const EVENT_TOGGLES: {
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
}[] = [
  {
    key: "confirmationDetected",
    label: "Confirmation detected",
    hint: "The confirmation layer found its required evidence at a tracked level. Not an approval to trade.",
  },
  {
    key: "setupInvalidated",
    label: "Setup invalidated",
    hint: "A tracked setup's premise failed — support lost, or structure gave way.",
  },
  {
    key: "setupDetected",
    label: "Potential setup",
    hint: "Every deterministic condition now holds. Off by default: several can appear in a busy session.",
  },
  {
    key: "structureChanged",
    label: "Structure changed",
    hint: "A level actually broke or was reclaimed. Off by default; fires more often than the others.",
  },
  {
    key: "dailySummary",
    label: "Daily scanner summary",
    hint: "One message a day with what every market said, including the no-trade counts.",
  },
  {
    key: "systemError",
    label: "Scanner errors",
    hint: "A market the scanner could not analyse. Grouped by the hour so a broken feed cannot spam.",
  },
];

export function NotificationSettings() {
  const queryClient = useQueryClient();
  const { status: authStatus } = useSession();
  const signedIn = authStatus === "authenticated";

  const prefs = useQuery<{ preferences: NotificationPreferences }>({
    queryKey: ["notification-preferences"],
    queryFn: () => fetchApi("/api/notifications/preferences"),
    enabled: signedIn,
  });

  const telegram = useQuery<{ telegram: TelegramStatus }>({
    queryKey: ["telegram-status"],
    queryFn: () => fetchApi("/api/notifications/telegram"),
    enabled: signedIn,
  });

  const save = useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) =>
      fetchApi("/api/notifications/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-preferences"] }),
  });

  // Settings already tells an anonymous visitor to sign in; a second card
  // saying the same thing would be noise.
  if (!signedIn) return null;

  if (prefs.isPending) return <Skeleton className="h-64 w-full" />;
  if (prefs.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(prefs.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const p = prefs.data!.preferences;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Notifications</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <section>
          <SectionLabel>Channels</SectionLabel>
          <Toggle
            label="In-app"
            hint="Shown on the Notifications page."
            checked={p.inAppEnabled}
            onChange={(v) => save.mutate({ inAppEnabled: v })}
          />
          <Toggle
            label="Telegram"
            hint={
              telegram.data?.telegram.connected
                ? `Sent to ${telegram.data.telegram.chatLabel ?? "your chat"}.`
                : "Connect a chat below first."
            }
            checked={p.telegramEnabled}
            disabled={!telegram.data?.telegram.connected}
            onChange={(v) => save.mutate({ telegramEnabled: v })}
          />
        </section>

        <Separator />

        <section>
          <SectionLabel>What to send</SectionLabel>
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            Defaults are deliberately quiet. A single scan can create dozens of setups, and a
            channel that announces all of them stops being read.
          </p>
          {EVENT_TOGGLES.map((toggle) => (
            <Toggle
              key={toggle.key}
              label={toggle.label}
              hint={toggle.hint}
              checked={Boolean(p[toggle.key])}
              onChange={(v) => save.mutate({ [toggle.key]: v })}
            />
          ))}
        </section>

        <Separator />

        <TelegramSection status={telegram.data?.telegram} isLoading={telegram.isPending} />
      </CardContent>
    </Card>
  );
}

function TelegramSection({
  status,
  isLoading,
}: {
  status: TelegramStatus | undefined;
  isLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      fetchApi<{ code: string }>("/api/notifications/telegram/connect", { method: "POST" }),
    onSuccess: (data) => {
      setCode(data.code);
      setMessage(null);
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const claim = useMutation({
    mutationFn: () =>
      fetchApi<{ result: { status: string; chatLabel?: string | null; error?: string } }>(
        "/api/notifications/telegram/claim",
        { method: "POST" },
      ),
    onSuccess: (data) => {
      if (data.result.status === "CONNECTED") {
        setCode(null);
        setMessage("Telegram connected.");
        queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
        queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      } else if (data.result.status === "EXPIRED" || data.result.status === "TOO_MANY_ATTEMPTS") {
        setCode(null);
        setMessage("That code is no longer valid. Generate a new one.");
      }
    },
  });

  const disconnect = useMutation({
    mutationFn: () => fetchApi("/api/notifications/telegram", { method: "DELETE" }),
    onSuccess: () => {
      setMessage("Telegram disconnected.");
      queryClient.invalidateQueries({ queryKey: ["telegram-status"] });
      queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
    },
  });

  const test = useMutation({
    mutationFn: () =>
      fetchApi<{ ok: boolean; error: string | null }>("/api/notifications/telegram/test", {
        method: "POST",
      }),
    onSuccess: (data) =>
      setMessage(data.ok ? "Test message sent." : (data.error ?? "The test message failed.")),
  });

  // While a code is on screen, ask the server whether the bot has seen it. The
  // alternative is a webhook, which would mean exposing this machine to the
  // internet to receive a message the user is about to send anyway.
  const claimMutate = claim.mutate;
  useEffect(() => {
    if (!code) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    pollRef.current = setInterval(() => claimMutate(), 3_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [code, claimMutate]);

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  return (
    <section>
      <SectionLabel>Telegram</SectionLabel>

      {!status?.configured && (
        <Alert variant="muted">
          <AlertDescription className="text-[11px]">
            No bot token is set on this machine. Add <code>TELEGRAM_BOT_TOKEN</code> to{" "}
            <code>.env</code> and restart to enable Telegram notifications.
          </AlertDescription>
        </Alert>
      )}

      {status?.connected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="bullish" className="text-[9px]">
              connected
            </Badge>
            <span className="text-muted-foreground">{status.chatLabel ?? "chat bound"}</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              {test.isPending ? "Sending…" : "Send test message"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {code ? (
            <div className="space-y-1.5">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Send this code to your SpotLens bot on Telegram. It expires in ten minutes and can
                only be used once.
              </p>
              <p className="tabular rounded-md bg-muted px-3 py-2 text-lg font-semibold tracking-widest">
                {code}
              </p>
              <p className="text-[11px] text-muted-foreground">
                Waiting for the bot to receive it…
              </p>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={() => connect.mutate()}
              disabled={connect.isPending || !status?.configured}
            >
              {connect.isPending ? "Generating…" : "Connect Telegram"}
            </Button>
          )}
        </div>
      )}

      {message && (
        <Alert variant="muted" className="mt-2">
          <AlertDescription className="text-[11px]">{message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-2 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-input accent-primary disabled:opacity-40"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
