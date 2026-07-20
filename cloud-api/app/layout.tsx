import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIVAN YT Summary Cloud API",
  description: "AIVAN Slide Studio 的 YT Summary Project JSON 雲端服務。",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
