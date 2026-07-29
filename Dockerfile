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
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh

# Create the storage tree *inside the image*, before ownership is fixed below.
#
# This matters when /app/storage is a mounted volume: Docker seeds an empty
# named volume from whatever the image has at that path, including ownership.
# Without this the volume would be created root-owned and the non-root process
# could not write batch PDFs or air waybills into it (EACCES).
RUN mkdir -p /app/storage/pdfs /app/storage/awb

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 80

# One image, two roles — selected with PROCESS_ROLE (api | worker).
# See scripts/docker-entrypoint.sh.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "./scripts/docker-entrypoint.sh"]
