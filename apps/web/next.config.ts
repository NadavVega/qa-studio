import type { NextConfig } from "next";
import { PORTS } from "@qa/core";

// /api/* goes to the Platform API, so the browser never needs CORS.
const config: NextConfig = {
  transpilePackages: ["@qa/core"],
  rewrites: async () => [{ source: "/api/:path*", destination: `http://localhost:${PORTS.api}/:path*` }],
};
export default config;
