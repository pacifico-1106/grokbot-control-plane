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
    "AIを入れるな。AI社員を雇え。手足のエージェントは強い。足りないのは会社の社員証・承認・台帳。Sealith の Staffpass がそれを埋める。まず Grok Bot（本線）、他は順次。日本の中小・零細の経営者・幹部向け。",
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
