/** 部署用:把 /api/* 反代到后端,前端可全程用相对路径(同源,无 CORS)。
 *  本地开发不依赖它(前端直连 API);Vercel 上配 BACKEND_URL=https://你的后端域名 */
const target = process.env.BACKEND_URL ?? 'http://localhost:8787';

/** @type {import('next').NextConfig} */
export default {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};
