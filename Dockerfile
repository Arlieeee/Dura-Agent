# my-agent server 镜像:tsx 直跑 TS(单进程网关+引擎;web 走 Vercel/静态托管,不进此镜像)
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# 先装依赖(利用层缓存):只装 server workspace,web 的 next/react 不进镜像
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --workspace apps/server --include=dev

# 再拷源码(protocol 是相对路径引用,无独立 package.json)
COPY packages ./packages
COPY apps/server ./apps/server

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["npm", "run", "start", "-w", "apps/server"]
