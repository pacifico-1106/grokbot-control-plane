import type { Metadata, Viewport } from "next";
import { Geist_Mono, Noto_Sans_JP } from "next/font/google";
import "./globals.css";

const notoSansJp = Noto_Sans_JP({
  variable: "--font-noto-sans-jp",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
  preload: true,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Staffpass — Sealith の AI社員 就業規則と日報",
  description:
    "AI社員の権限、承認、行為上限、監査を一つの社員証で管理するコントロールプレーン。",
  icons: {
    icon: [{ url: "/brand/staffpass-mark-dark-v2.png", type: "image/png" }],
    apple: [{ url: "/brand/staffpass-mark-dark-v2.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body
        className={`${notoSansJp.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
