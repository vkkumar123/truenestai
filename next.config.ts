import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Self-contained server bundle for the Cloud Run container (see Dockerfile, docs/DEPLOYMENT.md).
  output: "standalone",
  // Version-skew protection across rolling Cloud Run revisions. The deploy workflow sets it to the
  // git SHA; unset locally and in CI.
  deploymentId: process.env.DEPLOYMENT_VERSION || undefined,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
