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
  title: "創作者字幕翻譯庫",
  description: "貼連結或上傳影片,自動產生雙語字幕、摘要、可下載 SRT",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-Hant"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-gray-100 bg-white">
          <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-12">
            <a href="/" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              影片庫
            </a>
            <a href="/remix" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              短影片混剪
            </a>
            <a href="/clean" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              口播自動剪接
            </a>
            <a href="/search" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors ml-auto">
              全文搜尋
            </a>
            <a href="/glossary" className="text-sm font-bold text-gray-700 hover:text-orange-500 transition-colors">
              術語表
            </a>
            <a href="/featured" className="text-sm font-bold text-orange-600 hover:text-orange-700 transition-colors">
              ★ 推薦
            </a>
            <a href="/admin/storage" className="text-sm font-bold text-gray-500 hover:text-orange-500 transition-colors">
              磁碟用量
            </a>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
