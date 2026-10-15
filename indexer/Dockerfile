FROM node:20-bookworm-slim
WORKDIR /app/indexer
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY indexer/package.json indexer/package-lock.json ./
RUN npm ci --omit=dev
COPY indexer/src ./src
COPY indexer/tsconfig.json ./
COPY contracts/deployments /app/contracts/deployments
ENV DB_PATH=/data/disciple-indexer.sqlite PORT=4200
VOLUME /data
EXPOSE 4200
CMD ["npx", "tsx", "src/main.ts"]
