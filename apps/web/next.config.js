/** @type {import('next').NextConfig} */
const publicApiUrl = process.env.NEXT_PUBLIC_API_URL || "";
const internalApiBase = process.env.API_INTERNAL_URL
  || (publicApiUrl.startsWith("http") ? publicApiUrl : "http://localhost:4000");

const nextConfig = {
  transpilePackages: ["@devroom/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${internalApiBase}/:path*`,
      },
      {
        source: "/socket.io/:path*",
        destination: `${internalApiBase}/socket.io/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
