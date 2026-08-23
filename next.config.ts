import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      {
        source: "/docs/guides/instructions-design",
        destination: "/guides/instructions-design",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
