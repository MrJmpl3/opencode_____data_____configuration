# Dockerfile Patterns

## PHP / Laravel

```dockerfile
FROM php:8.2-fpm-alpine

# System dependencies
RUN apk add --no-cache \
    libpng-dev \
    libjpeg-turbo-dev \
    libzip-dev \
    oniguruma-dev \
    && docker-php-ext-install pdo_mysql gd mbstring zip bcmath opcache

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Install dependencies first (cache layer)
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist

# Copy application
COPY . .

# Finalize Composer
RUN composer dump-autoload --optimize \
    && chown -R www-data:www-data /var/www/html \
    && chmod -R 755 /var/www/html/storage \
    && chmod -R 755 /var/www/html/bootstrap/cache

USER www-data
EXPOSE 9000
CMD ["php-fpm"]
```

**Laravel-specific `.dockerignore`:**

```
.git
node_modules
vendor
.env
.env.*
storage/logs/*
storage/framework/cache/*
storage/framework/sessions/*
storage/framework/views/*
bootstrap/cache/*
*.log
```

## Node.js / Next.js (multi-stage)

```dockerfile
# Stage 1: Install dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Production runtime
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
```

## Python / FastAPI or Django

```dockerfile
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# System libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application
COPY . .

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

## Multi-Stage Build: General Pattern

```dockerfile
# ── build stage ──────────────────────────────────────────────
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server .

# ── runtime stage ─────────────────────────────────────────────
FROM scratch
COPY --from=builder /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
# Result: ~7MB final image with only the compiled binary
```

## Cache Mounts (BuildKit, 2025)

Use `--mount=type=cache` to persist package manager caches across builds:

```dockerfile
# Python
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Node.js
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# PHP Composer
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --prefer-dist
```

Enable BuildKit:

```bash
export DOCKER_BUILDKIT=1
docker build -t myapp .
# or set in daemon.json: {"features": {"buildkit": true}}
```

## ARG vs ENV

```dockerfile
# ARG: build-time only (not in running container)
ARG APP_ENV=production
ARG BUILD_DATE

# ENV: available at runtime
ENV APP_ENV=${APP_ENV}
ENV LOG_LEVEL=info

# Pass ARG at build time
# docker build --build-arg APP_ENV=staging -t myapp .
```

## Health Checks

```dockerfile
# HTTP endpoint check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Script-based check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD php artisan health:check || exit 1

# Simple process check
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD php-fpm-healthcheck || exit 1
```

## COPY vs ADD

- Use `COPY` for local files (preferred, explicit).
- Use `ADD` only when you need URL downloads or automatic tar extraction.

```dockerfile
# Good
COPY . /app
COPY --chown=www-data:www-data . /app

# ADD with extraction (valid use case)
ADD archive.tar.gz /app

# ADD with chown (BuildKit 2025 feature)
ADD --unpack=true --chown=appuser:appgroup archive.tar.gz /app
```
