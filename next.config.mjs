const viteOrigin = `http://127.0.0.1:${process.env.VITE_PORT || 5173}`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      beforeFiles: [{ source: "/:path*", destination: `${viteOrigin}/:path*` }],
    };
  },
};

export default nextConfig;
