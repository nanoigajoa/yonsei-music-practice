import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/__/auth/:path*',
        destination: 'https://yoneum-a8160.firebaseapp.com/__/auth/:path*',
      },
      {
        source: '/__/firebase/init.json',
        destination: 'https://yoneum-a8160.firebaseapp.com/__/firebase/init.json',
      },
    ]
  },
};

export default nextConfig;
