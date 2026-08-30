FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY vite.config.js ./
COPY frontend ./frontend
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends zip unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY server ./server
COPY --from=frontend-build /app/dist ./dist
COPY config.example.json ./config.example.json
RUN mkdir -p /app/chat
EXPOSE 3000
CMD ["node", "server/app.js"]
