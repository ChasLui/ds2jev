import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The CF plugin hijacks `vite build --ssr` when registered, so load it only for the worker target.
const target = process.env.DS2JEV_TARGET ?? "worker";

export default defineConfig({
  plugins: target === "worker" ? [cloudflare()] : [],
});
