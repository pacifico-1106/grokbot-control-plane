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
  title: "Staffpass — AI社員の就業規則と日報",
  description:
    "AIを入れるな。AI社員を雇え。Staffpassは就業規則と日報（制御面）。手足のエージェント基盤は差し替え可能で、まずGrok Botに対応。日本の中小・零細の経営者・幹部向け。",
  icons: {
    icon: [
      { url: "/brand/sealith-logo-stripe.svg", type: "image/svg+xml" },
      { url: "/brand/sealith-logo-stripe.png", type: "image/png" },
    ],
    apple: [{ url: "/brand/sealith-logo-stripe.png" }],
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
