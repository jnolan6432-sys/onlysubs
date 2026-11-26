import type { Metadata, Viewport } from "next";
import { TimezoneSync } from "./ui/timezone-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnlySubs",
  description: "Find a sub for your next game.",
  applicationName: "OnlySubs",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "OnlySubs",
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#102a43",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <TimezoneSync />
        {children}
      </body>
    </html>
  );
}
