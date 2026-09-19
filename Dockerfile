FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build:docker

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/dist/node/serve.js ./serve.js
ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787
USER node
CMD ["node", "serve.js"]