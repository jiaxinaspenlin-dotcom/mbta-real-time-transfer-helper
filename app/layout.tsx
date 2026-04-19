import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MBTA Transfer Helper",
  description: "Plan MBTA transfers with a live route map, Gemini station assist, and connection guidance."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
