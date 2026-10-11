import { defineConfig } from "vite";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Same-origin caption fonts (the page is cross-origin isolated, and Chinese
// subtitles must not depend on Google Fonts): the unicode-range CSS of the
// two @fontsource packages and the subsets it names, under /lib/fonts/.
const FONTS = { "noto-sans": ["latin-400.css"], "noto-sans-sc": ["400.css"] };
const fontRoot = (family) => dirname(require.resolve(`@fontsource/${family}/package.json`));

function captionFonts() {
  return {
    name: "yolo-caption-fonts",
    configureServer(server) {
      server.middlewares.use("/lib/fonts", (req, res, next) => {
        const [family, ...rest] = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "").split("/");
        if (!FONTS[family]) return next();
        const root = fontRoot(family);
        const file = normalize(join(root, ...rest));
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : "font/woff2");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [family, sheets] of Object.entries(FONTS)) {
        const root = fontRoot(family);
        const files = new Set();
        for (const sheet of sheets) {
          const css = readFileSync(join(root, sheet), "utf8");
          this.emitFile({ type: "asset", fileName: `lib/fonts/${family}/${sheet}`, source: css });
          for (const match of css.matchAll(/url\(\s*['"]?\.\/(files\/[^'")]+)['"]?\s*\)/g)) files.add(match[1]);
        }
        for (const file of files) {
          this.emitFile({ type: "asset", fileName: `lib/fonts/${family}/${file}`, source: readFileSync(join(root, file)) });
        }
      }
    },
  };
}

// `npm run dev` serves the client with Vite and sends Yolo's routes to a
// control plane (`npm run dev:control`, wrangler dev) at YOLO_CONTROL_URL.
const control = process.env.YOLO_CONTROL_URL || "http://127.0.0.1:8787";
const controlRoutes = ["/v1", "/m", "/oauth", "/device", "/login", "/account", "/auth", "/mcp", "/.well-known"];

export default defineConfig({
  plugins: [captionFonts()],
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: Object.fromEntries(controlRoutes.map((route) => [route, { target: control, ws: route === "/v1", changeOrigin: false }])),
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        player: resolve(__dirname, "index.html"),
        diagnostics: resolve(__dirname, "diag.html"),
      },
    },
  },
});
