# OrderPro

**Multi-platform order management system** for Indonesian e-commerce sellers. Centralize orders from Shopee and TikTok Shop into one dashboard with bulk printing, real-time sync, and role-based access.

---

## Tech Stack

| Layer        | Technology                                  |
| ------------ | ------------------------------------------- |
| Runtime      | Node.js 18+                                 |
| Framework    | Express.js                                  |
| Database     | PostgreSQL 15+ (via Prisma ORM)             |
| Cache/Queue  | Redis 7+ (BullMQ for background jobs)       |
| Auth         | JWT (bcryptjs for password hashing)         |
| PDF          | pdfmake                                     |
| Frontend     | React 18 + Tailwind CSS (separate repo)     |
| Deployment   | Docker Compose, PM2, Nginx                  |

---

## Prerequisites

- **Node.js** ≥ 18.x
- **PostgreSQL** ≥ 15
- **Redis** ≥ 7
- **npm** ≥ 9.x
- **Docker & Docker Compose** (for containerized deployment)

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/your-org/orderpro.git
cd orderpro
cp .env.example .env          # Edit with your database credentials
```

### 2. Run Setup

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

This will:
- Install npm dependencies
- Generate Prisma client
- Run database migrations
- Seed admin user + sample stores

### 3. Start Development Server

```bash
npm run dev
```

API runs at `http://localhost:3000`.

### 4. Login

| Account            | Email                | Password   | Role  |
| ------------------ | -------------------- | ---------- | ----- |
| Admin              | admin@orderpro.id    | admin123   | ADMIN |
| Staff              | staff@orderpro.id    | staff123   | STAFF |

---

## Docker Deployment

### Production

```bash
# Build and start all services
docker compose -f docker-compose.yml up -d --build

# View logs
docker compose logs -f api

# Stop
docker compose down
```

### Services

| Container  | Port  | Description                |
| ---------- | ----- | -------------------------- |
| `postgres` | 5432  | PostgreSQL database        |
| `redis`    | 6379  | Redis cache & queue        |
| `api`      | 3000  | Express API server         |
| `frontend` | 3001  | React frontend             |
| `nginx`    | 80    | Reverse proxy              |

### First Run (Docker)

```bash
# Run migrations inside the container
docker compose exec api npx prisma migrate deploy

# Seed the database
docker compose exec api node scripts/seed.js
```

---

## PM2 Deployment

For non-Docker production:

```bash
# Install PM2 globally
npm install -g pm2

# Start in production mode
pm2 start ecosystem.config.js --env production

# Monitor
pm2 monit

# View logs
pm2 logs orderpro-api

# Reload (zero-downtime)
pm2 reload ecosystem.config.js --env production

# Save process list (auto-start on reboot)
pm2 save
pm2 startup
```

---

## API Endpoints

### Auth

| Method | Endpoint              | Description              | Auth |
| ------ | --------------------- | ------------------------ | ---- |
| POST   | `/api/auth/register`  | Register new user        | No   |
| POST   | `/api/auth/login`     | Login, returns JWT       | No   |
| POST   | `/api/auth/refresh`   | Refresh access token     | Yes  |
| GET    | `/api/auth/me`        | Get current user profile | Yes  |

### Users

| Method | Endpoint           | Description       | Auth  | Role  |
| ------ | ------------------ | ----------------- | ----- | ----- |
| GET    | `/api/users`       | List all users    | Yes   | ADMIN |
| GET    | `/api/users/:id`   | Get user by ID    | Yes   | ADMIN |
| PUT    | `/api/users/:id`   | Update user       | Yes   | ADMIN |
| DELETE | `/api/users/:id`   | Delete user       | Yes   | ADMIN |

### Stores

| Method | Endpoint               | Description                 | Auth  | Role  |
| ------ | ---------------------- | --------------------------- | ----- | ----- |
| GET    | `/api/stores`          | List stores (filtered by role) | Yes   | Any   |
| POST   | `/api/stores`          | Create store                | Yes   | ADMIN |
| GET    | `/api/stores/:id`      | Get store details           | Yes   | Any   |
| PUT    | `/api/stores/:id`      | Update store                | Yes   | ADMIN |
| DELETE | `/api/stores/:id`      | Deactivate store            | Yes   | ADMIN |
| POST   | `/api/stores/:id/connect` | Reconnect marketplace    | Yes   | ADMIN |

### Orders

| Method | Endpoint                  | Description                | Auth  |
| ------ | ------------------------- | -------------------------- | ----- |
| GET    | `/api/orders`             | List orders (filterable)   | Yes   |
| GET    | `/api/orders/:id`         | Get order details          | Yes   |
| PUT    | `/api/orders/:id/status`  | Update order status        | Yes   |
| POST   | `/api/orders/bulk-update` | Bulk status update         | Yes   |
| GET    | `/api/orders/export`      | Export orders as CSV       | Yes   |

### Print

| Method | Endpoint                  | Description                  | Auth  |
| ------ | ------------------------- | ---------------------------- | ----- |
| POST   | `/api/print/resi`         | Generate shipping label PDF  | Yes   |
| POST   | `/api/print/resi/bulk`    | Bulk generate labels (ZIP)   | Yes   |
| GET    | `/api/print/resi/:id`     | Download generated label     | Yes   |

### Sync

| Method | Endpoint                   | Description                  | Auth  | Role  |
| ------ | -------------------------- | ---------------------------- | ----- | ----- |
| POST   | `/api/sync/orders`         | Trigger manual order sync    | Yes   | ADMIN |
| POST   | `/api/sync/orders/:storeId`| Sync specific store          | Yes   | ADMIN |
| GET    | `/api/sync/status`         | Get sync job status          | Yes   | Any   |

### System

| Method | Endpoint        | Description    | Auth |
| ------ | --------------- | -------------- | ---- |
| GET    | `/api/health`   | Health check   | No   |

---

## Project Structure

```
orderpro/
├── docker-compose.yml          # Docker orchestration
├── Dockerfile                  # API container build
├── ecosystem.config.js         # PM2 process config
├── package.json
├── .env.example
├── README.md
│
├── nginx/
│   └── default.conf            # Nginx reverse proxy config
│
├── prisma/
│   ├── schema.prisma           # Database schema
│   └── migrations/             # Auto-generated migrations
│
├── scripts/
│   ├── setup.sh                # One-command project setup
│   └── seed.js                 # Database seeder
│
├── src/
│   ├── server.js               # Express app entry point
│   ├── worker.js               # BullMQ background worker
│   ├── middleware/
│   │   ├── auth.js             # JWT authentication
│   │   └── validate.js         # Request validation
│   ├── routes/
│   │   ├── auth.js
│   │   ├── users.js
│   │   ├── stores.js
│   │   ├── orders.js
│   │   ├── print.js
│   │   └── sync.js
│   ├── services/
│   │   ├── shopee.js           # Shopee API client
│   │   ├── tiktok.js           # TikTok Shop API client
│   │   ├── pdf.js              # PDF generation
│   │   └── queue.js            # BullMQ queue setup
│   └── utils/
│       ├── logger.js
│       └── crypto.js           # Token encryption
│
├── storage/                    # Generated PDFs (gitignored)
│   └── resi/
│
├── logs/                       # PM2 logs (gitignored)
│
└── tests/
    ├── auth.test.js
    └── orders.test.js
```

---

## Environment Variables

| Variable            | Required | Default               | Description                          |
| ------------------- | -------- | --------------------- | ------------------------------------ |
| `DATABASE_URL`      | Yes      | —                     | PostgreSQL connection string         |
| `REDIS_URL`         | Yes      | `redis://localhost:6379` | Redis connection string           |
| `JWT_SECRET`        | Yes      | —                     | Secret for signing access tokens     |
| `JWT_REFRESH_SECRET`| Yes      | —                     | Secret for signing refresh tokens    |
| `JWT_EXPIRES_IN`    | No       | `15m`                 | Access token TTL                     |
| `JWT_REFRESH_EXPIRES_IN` | No  | `7d`                  | Refresh token TTL                    |
| `PORT`              | No       | `3000`                | Server port                          |
| `NODE_ENV`          | No       | `development`         | `development` / `production`         |
| `FRONTEND_URL`      | No       | `http://localhost:3001`| Allowed CORS origin                |
| `ENCRYPTION_KEY`    | Yes      | —                     | 32-byte key for encrypting API tokens|
| `SHOPEE_APP_ID`     | For sync | —                     | Shopee Open Platform App ID          |
| `SHOPEE_APP_SECRET` | For sync | —                     | Shopee Open Platform App Secret      |
| `TIKTOK_APP_KEY`    | For sync | —                     | TikTok Shop App Key                  |
| `TIKTOK_APP_SECRET` | For sync | —                     | TikTok Shop App Secret               |

---

## Common Issues / Troubleshooting

### `Error: P1001 - Can't reach database server`

- Ensure PostgreSQL is running: `docker compose up -d postgres` or `systemctl status postgresql`
- Check `DATABASE_URL` in `.env` matches your database credentials
- For Docker: ensure you're using the service name (`postgres`) not `localhost`

### `Error: connect ECONNREFUSED 127.0.0.1:6379`

- Ensure Redis is running: `docker compose up -d redis` or `redis-cli ping`
- Check `REDIS_URL` in `.env`

### `PrismaClientInitializationError`

- Run `npx prisma generate` after installing dependencies
- Ensure migrations are applied: `npx prisma migrate deploy`

### `CORS error` in browser

- Set `FRONTEND_URL` in `.env` to match your frontend's actual URL
- Include protocol: `http://localhost:3001` not just `localhost:3001`

### PDF generation fails / empty storage folder

- Ensure `storage/resi/` directory exists and is writable
- Check Node.js has write permissions: `chmod -R 755 storage/`

### PM2 app crashes immediately

- Check logs: `pm2 logs orderpro-api --lines 50`
- Ensure `.env` exists (PM2 doesn't source `.env` automatically — use `dotenv` in code)
- Verify all required env vars are set

### Shopee/TikTok sync not working

- Ensure API credentials are set in `.env` (App ID + Secret)
- Check that store tokens haven't expired — use `/api/stores/:id/connect` to refresh
- Review worker logs: `pm2 logs orderpro-worker`

---

## License

MIT © OrderPro Team
