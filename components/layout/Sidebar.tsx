"use client";

import {
  BookOpen,
  Calculator,
  Eye,
  LayoutDashboard,
  LineChart,
  Settings,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Phases after 1 land as stubs so the IA is final from day one. */
  comingSoon?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/market-analysis", label: "Market Analysis", icon: LineChart },
  { href: "/watchlist", label: "Watchlist", icon: Eye, comingSoon: true },
  { href: "/learn", label: "Learn", icon: BookOpen, comingSoon: true },
  { href: "/risk-calculator", label: "Risk Calculator", icon: Calculator, comingSoon: true },
  { href: "/settings", label: "Settings", icon: Settings, comingSoon: true },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-full shrink-0 flex-col border-b bg-card md:h-screen md:w-56 md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <LineChart className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">SpotLens</div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Spot analysis
          </div>
        </div>
      </div>

      <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
              {item.comingSoon && (
                <span className="ml-auto hidden rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground md:inline">
                  Soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto hidden px-4 py-4 md:block">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Spot trading only. No futures, margin, or leverage. SpotLens never places trades.
        </p>
      </div>
    </aside>
  );
}
