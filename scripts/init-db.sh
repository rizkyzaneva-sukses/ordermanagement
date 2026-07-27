#!/bin/bash
# PostgreSQL init script – ensures the database and user exist.
# Mounted into /docker-entrypoint-initdb.d/ by docker-compose.

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Extensions
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Grant full privileges to the application user
    GRANT ALL PRIVILEGES ON DATABASE "$POSTGRES_DB" TO "$POSTGRES_USER";
EOSQL

echo "✅  Database initialised."
