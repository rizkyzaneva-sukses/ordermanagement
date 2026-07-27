# ── Stage 1: Install dependencies ───────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Build (generate Prisma client) ─────────────
FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma/
RUN npx prisma generate

COPY . .

# ── Stage 3: Production runtime ────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini curl

WORKDIR /app

# Copy production deps + generated Prisma client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

# Copy source
COPY package.json ./
COPY prisma ./prisma/
COPY src ./src/
COPY scripts ./scripts/

# Ensure migration script is executable
RUN chmod +x scripts/*.sh 2>/dev/null || true

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# Run migrations then start the server
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
