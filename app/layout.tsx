import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "YT Summary & Remix",
  description: "YouTube/Podcast summary cards & multi-clip remix",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-gray-100 bg-white">
          <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-12">
            <a href="/" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              YT Summary
            </a>
            <a href="/remix" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              Short Video Remix
            </a>
            <a href="/clean" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              Auto Clean
            </a>
            <a href="/search" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors ml-auto">
              全文搜尋
            </a>
            <a href="/glossary" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              術語表
            </a>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
