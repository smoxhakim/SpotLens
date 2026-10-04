import { Bell } from "lucide-react";

import { NotificationList } from "@/features/notifications/components/NotificationList";

export const metadata = { title: "Notifications — SpotLens" };

export default function NotificationsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Bell className="h-5 w-5" />
          Notifications
        </h1>
        <p className="text-sm text-muted-foreground">
          What the scanner found while you were away. Each describes something that already happened
          on a closed candle, except &ldquo;Entry zone reached&rdquo;, which reports a live price
          arriving at a stored level — none of them is an instruction to trade.
        </p>
      </header>

      <NotificationList />
    </div>
  );
}
