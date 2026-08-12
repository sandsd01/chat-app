# Build the SPA in its own stage so its dev dependencies never reach the
# runtime image. src/app.js serves the resulting web/dist from the same origin
# as the API, which is what makes a single-container deploy possible.
FROM node:22-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim AS deps
WORKDIR /app
# Prisma's engines need OpenSSL, both to generate here and to run later.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# --ignore-scripts skips the postinstall `prisma generate`, which would run
# before prisma/ is copied in; it is run explicitly below instead.
RUN npm ci --omit=dev --ignore-scripts
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json package-lock.json prisma.config.ts ./
COPY src ./src
COPY --from=web-build /app/web/dist ./web/dist

RUN chown -R node:node /app
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run at start-up, not at build time: the database isn't reachable
# while the image is being built. `migrate deploy` only applies already-created
# migrations and never prompts, so it is safe to run on every boot.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
