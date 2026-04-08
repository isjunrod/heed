import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const SERVER_URL = process.env.VITE_API_BASE || "http://localhost:5001";

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5000,
		strictPort: true,
		proxy: {
			"/api": {
				target: SERVER_URL,
				changeOrigin: true,
				ws: true,
				// Disable buffering so SSE streams flush immediately
				selfHandleResponse: false,
				configure: (proxy) => {
					proxy.on("proxyRes", (proxyRes) => {
						// Force chunked transfer for SSE
						if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
							delete proxyRes.headers["content-length"];
						}
					});
				},
			},
		},
	},
	resolve: {
		alias: {
			"@heed/shared": fileURLToPath(new URL("../shared/types/index.ts", import.meta.url)),
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
