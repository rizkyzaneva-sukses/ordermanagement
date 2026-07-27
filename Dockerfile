# ── Stage 1: Install backend dependencies ──────────────
FROM node:20-alpine AS backend-deps

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Build frontend ───────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

COPY frontend ./
RUN NEXT_PUBLIC_API_URL=/api npm run build

# ── Stage 3: Build backend (generate Prisma client) ───
FROM node:20-alpine AS backend-build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma/
RUN npx prisma generate

# ── Stage 4: Production runtime ──────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini curl

WORKDIR /app

# Copy production deps
COPY --from=backend-deps /app/node_modules ./node_modules
# Copy generated Prisma client
COPY --from=backend-build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-build /app/node_modules/@prisma ./node_modules/@prisma

# Copy frontend build output
COPY --from=frontend-build /app/frontend/out ./frontend/out

# Copy backend source
COPY package.json ./
COPY prisma ./prisma/
COPY src ./src/

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 80

# Run migrations then start the server
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
