import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { Providers } from "@/components/providers";
import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";

import "./globals.css";

export const metadata: Metadata = {
  title: "SpotLens — Spot Trading Analysis",
  description:
    "Educational crypto spot trading analysis. Deterministic technical analysis with the reasoning shown. Not financial advice.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <Providers>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
              <footer className="border-t px-4 py-3 text-[11px] leading-relaxed text-muted-foreground md:px-6">
                {ANALYSIS_DISCLAIMER}
              </footer>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
