"use client";

import type { ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  FileText,
  LayoutDashboard,
  Loader2,
  Settings,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UserMenu, type AuthUser } from "@/components/layout/user-menu";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { AddSubscriptionButton } from "@/features/subscriptions/subscription-dialogs";
import { useMusicPlayer } from "@/features/dashboard/music/player-context";
import { MiniPlayer } from "@/features/dashboard/music/mini-player";
import { RouteProgress, startRouteProgress } from "@/components/layout/route-progress";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV: NavItem[] = [
  { href: "/subscriptions", label: "Subscriptions", icon: CalendarDays },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/serenity", label: "Serenity", icon: TrendingUp },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children, user }: { children: ReactNode; user?: AuthUser }) {
  const pathname = usePathname();
  const player = useMusicPlayer();
  // The mini-player floats only on non-dashboard routes (on /dashboard the
  // live player is docked inline inside the Music card). Reserve bottom space
  // for the bar only where it actually shows — extra on mobile to clear nav.
  const musicActive = player.queueLength > 0 && !pathname.startsWith("/dashboard");

  return (
    <div className="min-h-dvh">
      <div className="print:hidden">
        <RouteProgress />
      </div>

      {/* Sidebar — desktop */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] flex-col border-r border-border/60 glass px-4 py-6 lg:flex print:hidden">
        <div className="flex items-center gap-2.5 px-2">
          <div className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <Sparkles className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Subscription</div>
            <div className="text-xs text-muted-foreground">Agent</div>
          </div>
        </div>

        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <SidebarLink key={item.href} item={item} active={active} />
            );
          })}
        </nav>

        <div className="mt-auto rounded-xl border border-border/60 bg-surface/50 p-3">
          <div className="text-xs font-medium">Beta Versions 0.1</div>
          <div className="mt-1 text-xs text-muted-foreground">Up to 10 Testers</div>
        </div>
      </aside>

      {/* Main column */}
      <div className="lg:pl-[248px] print:pl-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-border/60 glass px-4 sm:px-6 print:hidden">
          <span className="text-sm font-medium text-muted-foreground lg:hidden">
            Subscription Agent
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <AddSubscriptionButton size="sm" label="Add" />
            {user ? <UserMenu user={user} /> : null}
          </div>
        </header>

        <main
          className={cn(
            "px-4 pb-28 pt-6 sm:px-6 lg:pb-10",
            musicActive && "pb-44 lg:pb-28",
          )}
        >
          {children}
        </main>
      </div>

      {/* Persistent music bar — survives navigation between app pages */}
      <div className="print:hidden">
        <MiniPlayer />
      </div>

      {/* Bottom nav — mobile */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border/60 glass px-2 py-2 lg:hidden print:hidden">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return <BottomNavLink key={item.href} item={item} active={active} />;
        })}
      </nav>
    </div>
  );
}

/**
 * Desktop sidebar link. On click it kicks the global top progress bar
 * (immediate feedback), and while its own route is fetching, `useLinkStatus`
 * swaps the icon for a spinner and lifts the row into a subtle "pending" style
 * — so the user sees the click landed even before the new page paints.
 */
function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={() => startRouteProgress()}
      className={cn(
        "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <NavIcon item={item} active={active} />
      {item.label}
    </Link>
  );
}

function NavIcon({ item, active }: { item: NavItem; active: boolean }) {
  const { pending } = useLinkStatus();
  if (pending) {
    return <Loader2 className="size-4 animate-spin text-primary" />;
  }
  return (
    <item.icon
      className={cn(
        "size-4",
        active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
      )}
    />
  );
}

/** Mobile bottom-nav link with the same instant-feedback behavior. */
function BottomNavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={() => startRouteProgress()}
      className={cn(
        "flex flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] transition-colors",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      <BottomNavIcon item={item} active={active} />
      {item.label}
    </Link>
  );
}

function BottomNavIcon({ item, active }: { item: NavItem; active: boolean }) {
  const { pending } = useLinkStatus();
  if (pending) return <Loader2 className="size-5 animate-spin text-primary" />;
  return <item.icon className={cn("size-5", active && "text-primary")} />;
}
