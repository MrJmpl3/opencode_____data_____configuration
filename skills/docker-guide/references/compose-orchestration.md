# Docker Compose Orchestration

## Full-Stack Laravel Example

```yaml
# compose.yml
services:
  # PHP-FPM application
  app:
    build:
      context: .
      dockerfile: docker/php-fpm/Dockerfile
    volumes:
      - ./:/var/www/html
      - storage_data:/var/www/html/storage
    environment:
      - APP_ENV=${APP_ENV:-local}
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

  # Nginx web server
  nginx:
    image: nginx:1.26-alpine
    ports:
      - "${APP_PORT:-8080}:80"
    volumes:
      - ./:/var/www/html
      - ./docker/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - app
    restart: unless-stopped

  # MySQL database
  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${DB_DATABASE}
      MYSQL_USER: ${DB_USERNAME}
      MYSQL_PASSWORD: ${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql
      - ./docker/mysql/conf.d:/etc/mysql/conf.d:ro
    ports:
      - "${DB_PORT:-3306}:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u${DB_USERNAME}", "-p${DB_PASSWORD}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  # Redis cache / queue
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    ports:
      - "${REDIS_PORT:-6379}:6379"
    restart: unless-stopped

  # Laravel queue worker
  queue:
    build:
      context: .
      dockerfile: docker/php-fpm/Dockerfile
    command: php artisan queue:work --sleep=3 --tries=3 --timeout=90
    volumes:
      - ./:/var/www/html
    depends_on:
      - db
      - redis
    restart: unless-stopped

volumes:
  db_data:
  redis_data:
  storage_data:
```

## Network Isolation Pattern

Separate frontend and backend networks for security:

```yaml
services:
  web:
    networks:
      - frontend

  api:
    networks:
      - frontend
      - backend

  db:
    networks:
      - backend       # Not reachable from frontend

  redis:
    networks:
      - backend

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true    # No external internet access
```

## Environment Variables Strategy

```yaml
services:
  app:
    # Load from file (preferred for dev)
    env_file:
      - .env

    # Override specific vars inline
    environment:
      - LOG_CHANNEL=stderr
      - CACHE_DRIVER=redis

    # For Swarm mode secrets
    secrets:
      - db_password

secrets:
  db_password:
    external: true
```

**File hierarchy:**
- `.env` — local overrides (gitignored)
- `.env.example` — committed template with placeholder values
- `.env.testing` — test environment values

## Dependency Management

```yaml
services:
  api:
    depends_on:
      database:
        condition: service_healthy   # Wait for health check to pass
      redis:
        condition: service_started   # Just wait for container start
      migration:
        condition: service_completed_successfully  # Wait for one-shot job

  migration:
    image: myapp
    command: php artisan migrate --force
    restart: "no"
```

## Volume Patterns

```yaml
volumes:
  # Named volume (managed by Docker, persists across down/up)
  db_data:
    driver: local

  # Named volume with custom driver options
  nfs_data:
    driver: local
    driver_opts:
      type: nfs
      o: addr=192.168.1.100,rw
      device: ":/exports/data"

services:
  app:
    volumes:
      # Source code (development hot-reload)
      - ./src:/app/src

      # Named volume (persistent data)
      - db_data:/var/lib/mysql

      # Read-only config
      - ./nginx.conf:/etc/nginx/nginx.conf:ro

      # Anonymous volume (node_modules isolation)
      - /app/node_modules

      # Image-type volume (Docker 2025, read-only data distribution)
      - type: image
        source: mydata:latest
        target: /data
        read_only: true
```

## Resource Limits

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
```

## Logging Configuration

```yaml
services:
  app:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Or globally in `/etc/docker/daemon.json`:
```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

## Development vs Production Compose

Use override files to separate concerns:

```yaml
# compose.yml — base (shared by all envs)
services:
  app:
    image: myapp:${TAG:-latest}
    environment:
      - APP_ENV=production

# compose.override.yml — local dev (auto-loaded)
services:
  app:
    build: .
    volumes:
      - .:/app
    environment:
      - APP_ENV=local
      - APP_DEBUG=true
    command: php artisan serve --host=0.0.0.0
```

```bash
# Development (loads compose.yml + compose.override.yml automatically)
docker compose up

# Production (explicit, no override)
docker compose -f compose.yml up -d
```

## Compose v2.40+ New Features

```yaml
# Develop watch (hot reload, replaces volumes for CI/CD compatibility)
services:
  app:
    build: .
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
          initial_sync: full     # Sync all files on start (2025 feature)
        - action: rebuild
          path: composer.json    # Rebuild image when deps change
```

```bash
# Start with watch mode
docker compose watch

# Debug complex build configurations
docker compose build --print > build-config.json

# View raw config without env var substitution
docker compose config --no-env-resolution
```

## Docker Compose to Kubernetes (Compose Bridge, 2025)

```bash
# Convert Compose file to Kubernetes manifests
docker compose convert --format kubernetes > k8s-manifests.yaml

# Apply to cluster
kubectl apply -f k8s-manifests.yaml
```
