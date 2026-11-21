# Always-on trade relay (web/relay/server.ts). Build from the REPO ROOT:
#   fly deploy --config web/relay/fly.toml
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY web/package.json web/package.json
COPY sdk sdk
RUN pnpm install --frozen-lockfile --filter web... --ignore-scripts
COPY web web
# esbuild comes in through tsx; pnpm keeps every dep under .pnpm/node_modules
RUN cd web && NODE_PATH=/app/node_modules/.pnpm/node_modules node relay/build.mjs

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 TRUSTED_PROXY=1
WORKDIR /relay
COPY --from=build /app/web/relay/dist/ ./
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "server.cjs"]
