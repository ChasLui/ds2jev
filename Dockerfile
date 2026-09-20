FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com && npm install -g pnpm@12.5.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build:docker

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/node/serve.js ./serve.js
ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "serve.js"]