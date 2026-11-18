# Imagem única para todos os serviços Node (SERVICE define qual sobe)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services ./services-src
RUN mkdir services && for d in services-src/*; do n="$(basename "$d")"; mkdir -p "services/$n" && cp "$d/package.json" "services/$n/"; done \
 && npm ci --omit=dev --ignore-scripts && rm -rf services-src

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY services ./services
USER 1000:1000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["wget", "-qO-", "http://127.0.0.1:3000/health"]
CMD ["sh", "-c", "node services/$SERVICE/src/index.js"]
