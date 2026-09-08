"use client";

import { AlertTriangle } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      if (isRegister) {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => null);
          setError(body?.error?.message ?? "Could not create the account.");
          return;
        }
      }

      const result = await signIn("credentials", { email, password, redirect: false });

      if (result?.error) {
        setError("That email and password did not match an account.");
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mx-auto mt-12 w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-base">
          {isRegister ? "Create your account" : "Sign in to SpotLens"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              required
              minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {isRegister && (
              <p className="text-[11px] text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters. Length matters more than symbols.
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </Button>

          <p className="text-center text-[11px] text-muted-foreground">
            {isRegister ? "Already have an account? " : "No account yet? "}
            <Link
              href={isRegister ? "/login" : "/register"}
              className="text-primary underline underline-offset-2"
            >
              {isRegister ? "Sign in" : "Create one"}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
