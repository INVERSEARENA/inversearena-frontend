import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { ThemeProvider } from "next-themes";
import { ClientProviders } from "./ClientProviders";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { StellarSetupBanner } from "@/components/dev/StellarSetupBanner";

import { Geist, Geist_Mono, Press_Start_2P, Space_Grotesk } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const pressStart2P = Press_Start_2P({
  variable: "--font-pixel",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Inverse Arena",
  description: "Inverse Arena - Stellar Soroban",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce minted per request by src/proxy.ts (#1296). next-themes injects an
  // inline anti-flash <script>, so it must be told the nonce now that
  // 'unsafe-inline' is gone from script-src.
  const nonce = (await headers()).get("x-nonce") || undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${pressStart2P.variable} ${spaceGrotesk.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          {...(nonce ? { nonce } : {})}
        >
          <ServiceWorkerRegister />
          <StellarSetupBanner />
          <ErrorBoundary>
            <ClientProviders>
              {children}
            </ClientProviders>
          </ErrorBoundary>
        </ThemeProvider>
      </body>
    </html>
  );
}
