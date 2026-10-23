import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { ThemeProvider } from "next-themes";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { ClientProviders } from "./ClientProviders";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServiceWorkerRegister } from "@/components/pwa/ServiceWorkerRegister";
import { StellarSetupBanner } from "@/components/dev/StellarSetupBanner";
import { LOCALE_COOKIE, resolveLocale } from "@/i18n/config";

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

  // #1575: locale is resolved entirely on the server (cookie → Accept-Language
  // → default), so <html lang>, the message catalog and
  // NextIntlClientProvider all agree before hydration — no mismatch possible.
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const locale = resolveLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    requestHeaders.get("accept-language"),
  );
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
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
          <NextIntlClientProvider locale={locale} messages={messages}>
            <ServiceWorkerRegister />
            <StellarSetupBanner />
            <ErrorBoundary>
              <ClientProviders>
                {children}
              </ClientProviders>
            </ErrorBoundary>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
