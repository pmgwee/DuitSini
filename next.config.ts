import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray package-lock.json in the user's home directory makes Next infer the
  // wrong workspace root. Pin file tracing to this project's directory.
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
