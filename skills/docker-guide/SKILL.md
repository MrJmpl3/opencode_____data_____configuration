---
name: docker-guide
description: "Use when working with Docker basics, local builds, container debugging, volumes, networks, and simple Compose workflows."
---

# Docker

## Follow this workflow

- Identify the task scope: single container, multi-service Compose stack, or debugging.
- Use Docker Compose for local multi-container setups; use `docker-orchestration` for stack design and `docker-production` for production overlays.
- For Dockerfile tuning or runtime hardening, use `dockerfile-optimizer`.
- Test with `docker compose config` to validate YAML before running.

## Use this quick start

```bash
# Build image
docker build -t app:local .

# Start full stack
docker compose up -d --build

# Validate service health
docker compose ps
docker compose logs -f app

# Stop stack
docker compose down
```

## Core concepts

**Images vs Containers:**

- Image: read-only template with code, runtime, and dependencies.
- Container: running instance of an image with a writable layer.
- Registry: image storage (Docker Hub, GHCR, private registries).

**Volumes:**

```bash
docker run -v named_volume:/app/data image   # Named volume (persists)
docker run -v $(pwd)/data:/app/data image    # Bind mount (host path)
```

**Networks:**

```bash
docker network create mynet
docker run --network mynet --name db postgres
docker run --network mynet --name app myapp  # 'app' reaches 'db' by hostname
```

## Docker Compose essentials

```yaml
# compose.yaml (no version field needed in Compose v2.40+)
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    environment:
      - APP_ENV=local
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./src:/app/src
    restart: unless-stopped

  db:
    image: mysql:8-alpine
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: ${DB_DATABASE}
    volumes:
      - db_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  db_data:
```

**Essential Compose commands:**

```bash
docker compose up -d               # Start all services (detached)
docker compose up --build          # Rebuild images before starting
docker compose down                # Stop and remove containers
docker compose down -v             # Also remove volumes
docker compose logs -f service     # Stream logs for one service
docker compose exec service sh     # Shell into running container
docker compose run --rm service cmd # One-off command in new container
docker compose ps                  # List service status
docker compose config              # Validate and print merged config
```

## Working with containers

```bash
# Lifecycle
docker build -t name:tag .
docker run -d --name app -p 8080:80 name:tag
docker stop app && docker rm app

# Inspection
docker logs -f app
docker exec -it app /bin/sh
docker inspect app
docker stats                        # Real-time CPU/memory

# Cleanup
docker system prune -a              # Remove all unused resources
docker volume prune                 # Remove unused volumes
docker image prune                  # Remove dangling images
```

## Enforce these rules

- Never use `docker-compose` (v1); use `docker compose` (v2 plugin).
- Always include `.dockerignore` to exclude `vendor/`, `node_modules/`, `.git/`, `.env`.

## Verify results

- Build validation passes with `docker build -t app:local .`.
- Compose syntax validation passes with `docker compose config`.
- Runtime smoke test passes with `docker compose up -d && docker compose ps && docker compose logs --tail 50 app`.
- Debug workflow is executable with `docker logs`, `docker inspect`, `docker exec`, `docker network inspect`, and `docker system prune`.
- Reference coverage is complete: Docker basics, orchestration, and debugging.
- Guidance remains implementation/diagnosis focused and does not include production hardening policy.

## Quick diagnostics

```bash
# Container won't start
docker logs container_name
docker inspect -f '{{.State.ExitCode}}' container_name
docker run -it --entrypoint /bin/sh image_name    # Override entrypoint to debug

# Volume appears empty
docker inspect -f '{{.Mounts}}' container_name

# Port already in use
lsof -i :PORT && kill -9 <PID>

# Build context too large
du -sh . && cat .dockerignore

# Out of disk space
docker system df && docker system prune -a --volumes
```

## Read this reference when needed

- `.agents/skills/docker-guide/references/dockerfile-patterns.md` — multi-stage builds, framework-specific Dockerfiles (PHP/Laravel, Node.js, Python)
- `.agents/skills/docker-guide/references/compose-orchestration.md` — full-stack Compose examples, network isolation, named volumes, Swarm mode
- `.agents/skills/docker-guide/references/debugging-techniques.md` — container debugging techniques, network diagnosis, resource monitoring

## Consult related skills

- `docker-orchestration` — multi-service stacks, networks, volumes, overrides, and local development flows
- `docker-production` — production hardening, resource management, backups, logging, and resilience
- `dockerfile-optimizer` — Dockerfile optimization, multi-stage builds, image size, and build caching
- `docker-best-practices` — image optimization, runtime security, production checklists, 2025 features
