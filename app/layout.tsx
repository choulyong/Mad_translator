import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/domain/sidebar";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-display",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#17cf5a",
};

export const metadata: Metadata = {
  title: "Movie Renamer Dashboard",
  description: "Scan, identify, and rename movie files using TMDB metadata",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Renamer",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="dark" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-[family-name:var(--font-display)] bg-background-dark text-zinc-300 min-h-screen flex antialiased`}
      >
        <Sidebar />
        <main className="ml-0 md:ml-64 flex-1 flex flex-col min-w-0 bg-background-dark min-h-screen">
          {children}
        </main>
        <Toaster
          position="bottom-right"
          theme="dark"
          toastOptions={{
            style: {
              background: "#18181b",
              border: "1px solid #27272a",
              color: "#e4e4e7",
            },
          }}
        />
      </body>
    </html>
  );
}
