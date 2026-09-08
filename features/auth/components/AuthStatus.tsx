"use client";

import { LogIn, LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Sign-in state in the sidebar footer. */
export function AuthStatus() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <div className="h-8" aria-hidden />;
  }

  if (!session?.user) {
    return (
      <Button asChild variant="outline" size="sm" className="w-full">
        <Link href="/login">
          <LogIn className="h-3.5 w-3.5" />
          Sign in
        </Link>
      </Button>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="truncate text-[11px] text-muted-foreground" title={session.user.email ?? ""}>
        {session.user.email}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start px-2"
        onClick={() => signOut({ callbackUrl: "/" })}
      >
        <LogOut className="h-3.5 w-3.5" />
        Sign out
      </Button>
    </div>
  );
}
