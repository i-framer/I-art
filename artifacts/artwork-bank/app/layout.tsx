import type { Metadata } from "next";
import "./globals.css";
import { ensureEmailSweepScheduler } from "@/lib/email-sweep-scheduler";

// Start the background confirmation-email sweep (no-op if already running).
// Skip during `next build` page-data collection and when no database is
// configured, so builds succeed without DATABASE_URL.
if (
  process.env.NEXT_PHASE !== "phase-production-build" &&
  process.env.DATABASE_URL
) {
  ensureEmailSweepScheduler();
}

export const metadata: Metadata = {
  title: {
    default: "Artwork Bank",
    template: "%s | Artwork Bank",
  },
  description: "Sell and manage artwork online",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
