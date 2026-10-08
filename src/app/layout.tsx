import type { Metadata } from "next";
import type { ReactNode } from "react";
import "katex/dist/katex.min.css";
import "@/features/dictation/dictation.css";
import "./globals.css";

export const metadata: Metadata = { title: "Chat Dictation Demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
