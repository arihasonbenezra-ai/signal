import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  /** Set to "0" to silence [vite:anthropic-proxy] logs */
  const logProxy = env.VITE_ANTHROPIC_PROXY_DEBUG !== "0"

  const log = (...args) => {
    if (logProxy) console.log("[vite:anthropic-proxy]", ...args)
  }

  return {
    plugins: [react()],
    server: {
      // Block dev static middleware from serving api/** (proxy still handles /api/anthropic first).
      fs: {
        deny: [
          ".env",
          ".env.*",
          "*.{crt,pem}",
          "**/.git/**",
          "**/api/**",
        ],
      },
      proxy: {
        "/api/anthropic": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ""),
          // Merged in http-proxy setupOutgoing() before the upstream request is created — avoids a
          // race where proxyReq.setHeader in a proxyReq listener runs after req.pipe(proxyReq) began.
          headers: {
            ...(env.ANTHROPIC_API_KEY ? { "x-api-key": env.ANTHROPIC_API_KEY } : {}),
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq, req) => {
              log("request", {
                method: req.method,
                url: req.url,
                incomingContentLength: req.headers["content-length"],
                incomingContentType: req.headers["content-type"],
                outgoingContentLength: proxyReq.getHeader("content-length"),
                hasApiKey: Boolean(env.ANTHROPIC_API_KEY),
              })
            })
            proxy.on("proxyRes", (proxyRes, req) => {
              log("response", req.method, req.url, {
                status: proxyRes.statusCode,
                contentLength: proxyRes.headers["content-length"],
                contentType: proxyRes.headers["content-type"],
              })
            })
            proxy.on("error", (err, req, res) => {
              console.error("[vite:anthropic-proxy] error", err?.message ?? err, {
                method: req?.method,
                url: req?.url,
                headersSent: res?.headersSent,
              })
            })
          },
        },
      },
    },
  }
})
