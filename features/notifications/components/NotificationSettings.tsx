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

type TelegramBot = "MAIN" | "CONFIRMATION";

interface TelegramStatus {
  bot: TelegramBot;
  configured: boolean;
  /** Which variable to set, so an unconfigured bot names the right one. */
  tokenVariable: string;
  /** The bot's public @username, when the server could ask Telegram for it. */
  botUsername: string | null;
  connected: boolean;
  chatLabel: string | null;
  connectedAt: string | null;
  pending: boolean;
}

/**
 * What each bot carries, in the words a reader chooses by.
 *
 * Two bots is one more thing to understand than one, so the panel has to be
 * explicit about why: the main bot carries lifecycle events, the confirmation
 * bot carries the per-candle evidence that would otherwise bury them. That is
 * the whole reason the second one exists, and it is the only thing a reader
 * needs to know to decide whether to connect it.
 */
const BOT_COPY: Record<
  TelegramBot,
  { title: string; blurb: string; connect: string; queryKey: string }
> = {
  MAIN: {
    title: "Main SpotLens bot",
    blurb:
      "Potential setups, invalidations and the daily summary — the events that say a tracked " +
      "setup's situation has changed.",
    connect: "Connect Telegram",
    queryKey: "telegram-status",
  },
  CONFIRMATION: {
    title: "Confirmation alerts",
    blurb:
      "A separate bot for confirmation evidence as it appears at a tracked level, so it cannot " +
      "bury the main channel. Each setup is followed on its own, the first look at a setup is a " +
      "silent baseline, and the same evidence is never announced twice.",
    connect: "Connect confirmation alerts",
    queryKey: "telegram-status-confirmation",
  },
};

/**
 * Each toggle names the event and says plainly how often it fires, because
 * "how noisy is this?" is the only question that matters when choosing.
 *
 * The frequencies here are measured, not guessed. An earlier version described
 * the rarest event as a firehose and the noisiest as routine, which is a worse
 * failure than saying nothing: someone choosing on those hints chose backwards.
 *
 * `inApp` marks the events that are recorded and shown here but never pushed to
 * Telegram, so the switch does not promise a message that will not arrive.
 */
const EVENT_TOGGLES: {
  key: keyof NotificationPreferences;
  label: string;
  hint: string;
  inApp?: boolean;
}[] = [
  {
    key: "setupDetected",
    label: "Potential setup",
    hint: "Every deterministic condition now holds. The rarest thing the engine says — roughly one in every seventy notifications — and the one most worth reading.",
  },
  {
    key: "confirmationDetected",
    label: "Confirmation evidence",
    inApp: true,
    hint: "The lifecycle reached confirmation-detected: the confirmation layer found its evidence and the analysis was still not promoted. Recorded here and kept in the setup's history. It no longer reaches the main bot — confirmation traffic moved to its own bot, which is the point of having one.",
  },
  {
    key: "setupInvalidated",
    label: "Setup invalidated",
    hint: "A tracked setup's premise failed — support lost, or structure gave way. The most common event by a wide margin. A setup the engine merely re-anchored to a neighbouring zone is shown here as 're-anchored' and never pushed.",
  },
  {
    key: "structureChanged",
    label: "Structure signal",
    inApp: true,
    hint: "One piece of structural evidence at a tracked level — a break upward, or a zone reclaimed. Rare, and always in the setup's favour, since an adverse break arrives as an invalidation instead.",
  },
  {
    key: "confirmationAlerts",
    label: "Confirmation alerts",
    hint: "New confirmation evidence at a tracked level, and the moment the deterministic confirmation check has everything it requires. These go to the confirmation bot below — never to the main one.",
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

  const confirmation = useQuery<{ telegram: TelegramStatus }>({
    queryKey: ["telegram-status-confirmation"],
    queryFn: () => fetchApi("/api/notifications/telegram?bot=CONFIRMATION"),
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
            These switches decide what is recorded and shown in the app. Telegram receives a
            deliberate subset of it — the quiet events stay here rather than reaching your phone,
            and nothing is ever dropped from the record.
          </p>
          {EVENT_TOGGLES.map((toggle) => (
            <Toggle
              key={toggle.key}
              label={toggle.inApp ? `${toggle.label} (in-app only)` : toggle.label}
              hint={toggle.hint}
              checked={Boolean(p[toggle.key])}
              onChange={(v) => save.mutate({ [toggle.key]: v })}
            />
          ))}
        </section>

        <Separator />

        <TelegramSection
          bot="MAIN"
          status={telegram.data?.telegram}
          isLoading={telegram.isPending}
        />

        <Separator />

        <TelegramSection
          bot="CONFIRMATION"
          status={confirmation.data?.telegram}
          isLoading={confirmation.isPending}
        />
      </CardContent>
    </Card>
  );
}

function TelegramSection({
  bot,
  status,
  isLoading,
}: {
  bot: TelegramBot;
  status: TelegramStatus | undefined;
  isLoading: boolean;
}) {
  const copy = BOT_COPY[bot];
  // One query string for every call in this section, so a bot's connect, claim,
  // test and disconnect cannot end up addressing different bots.
  const query = `?bot=${bot}`;
  const queryClient = useQueryClient();
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connect = useMutation({
    mutationFn: () =>
      fetchApi<{ code: string }>(`/api/notifications/telegram/connect${query}`, { method: "POST" }),
    onSuccess: (data) => {
      setCode(data.code);
      setMessage(null);
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const claim = useMutation({
    mutationFn: () =>
      fetchApi<{ result: { status: string; chatLabel?: string | null; error?: string } }>(
        `/api/notifications/telegram/claim${query}`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      if (data.result.status === "CONNECTED") {
        setCode(null);
        setMessage(`${copy.title} connected.`);
        queryClient.invalidateQueries({ queryKey: [copy.queryKey] });
        queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      } else if (data.result.status === "EXPIRED" || data.result.status === "TOO_MANY_ATTEMPTS") {
        setCode(null);
        setMessage("That code is no longer valid. Generate a new one.");
      } else if (data.result.status === "UNAVAILABLE") {
        // Said out loud rather than swallowed. Without this the panel sits on
        // "waiting for the bot" forever while every poll is failing, which
        // looks identical to a user who has simply not sent the code yet.
        setMessage(data.result.error ?? "Telegram could not be reached.");
      } else {
        setMessage(null);
      }
    },
    onError: (err: Error) => setMessage(err.message),
  });

  const disconnect = useMutation({
    mutationFn: () => fetchApi(`/api/notifications/telegram${query}`, { method: "DELETE" }),
    onSuccess: () => {
      setMessage(`${copy.title} disconnected.`);
      queryClient.invalidateQueries({ queryKey: [copy.queryKey] });
      queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
    },
  });

  const test = useMutation({
    mutationFn: () =>
      fetchApi<{ ok: boolean; error: string | null }>(`/api/notifications/telegram/test${query}`, {
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
      <SectionLabel>{copy.title}</SectionLabel>
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{copy.blurb}</p>

      {!status?.configured && (
        <Alert variant="muted">
          <AlertDescription className="text-[11px]">
            No bot token is set on this machine. Add{" "}
            <code>{status?.tokenVariable ?? "the bot token"}</code> to <code>.env</code> and restart
            to enable this channel.
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
                Send this code to the {copy.title.toLowerCase()} bot on Telegram. It expires in ten
                minutes and can only be used once. Each bot needs its own code — a chat bound to one
                cannot be messaged by the other until you have started it there.
              </p>
              <p className="tabular rounded-md bg-muted px-3 py-2 text-lg font-semibold tracking-widest">
                {code}
              </p>
              {status?.botUsername && (
                // The link carries the code as Telegram's own start parameter,
                // so the user taps Start and the bot receives it — no retyping
                // on a phone, and no chat ID to copy by hand anywhere.
                <Button asChild size="sm">
                  <a
                    href={`https://t.me/${status.botUsername}?start=${code}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open @{status.botUsername}
                  </a>
                </Button>
              )}
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
              {connect.isPending ? "Generating…" : copy.connect}
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
