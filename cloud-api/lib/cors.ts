import { NextRequest } from "next/server";

const DEFAULT_ORIGINS = [
  "https://aivan-slide-studio.vercel.app",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
];

function allowedOrigins(): Set<string> {
  const configured = (process.env.AIVAN_SLIDE_STUDIO_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...configured]);
}

export function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins();

  return {
    ...(allowed.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}
