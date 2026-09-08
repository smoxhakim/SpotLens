/**
 * Security headers.
 *
 * The CSP allows the exchange's REST and WebSocket origins because the browser
 * talks to them directly — that is the architecture's realtime design, not an
 * oversight. 'unsafe-inline' and 'unsafe-eval' in script-src are what Next.js
 * requires for its hydration and dev tooling; tightening that needs nonces
 * through a middleware, which is worth doing if this ever serves other people.
 */
const isDev = process.env.NODE_ENV !== "production";

const binanceRest = process.env.BINANCE_API_BASE_URL || "https://api.binance.com";
const binanceWs = process.env.NEXT_PUBLIC_BINANCE_WS_BASE_URL || "wss://stream.binance.com:9443";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${binanceRest} ${binanceWs}${isDev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Emits a self-contained server bundle for the Docker runtime stage.
  output: "standalone",
  images: {
    domains: [],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
