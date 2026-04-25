---
name: docker-orchestration
description: "Use when designing Docker Compose stacks for multi-container applications, networking, volumes, profiles, and local development workflows."
---

# Docker Compose Orchestration

Use this skill for multi-service application stacks and local development environments.

## Use this skill for

- Building web, API, database, and cache stacks
- Defining service dependencies and startup order
- Configuring networks and persistent volumes
- Using `compose.override.yaml` for local-only changes
- Debugging service startup, connectivity, and mounts

## Do not use this skill for

- Production hardening, monitoring, backups, or high availability. Use `docker-production`.
- Dockerfile optimization. Use `dockerfile-optimizer`.
- Single-container debugging. Use `docker-guide`.

## Rules

- Use `docker compose`, not `docker-compose`.
- Use `compose.yaml` as the base file.
- Use `compose.override.yaml` for local overrides.
- Do not add `version:` to Compose files.

## Compose anatomy

- `services` for containers
- `networks` for service communication
- `volumes` for persistent data
- `configs` for non-sensitive config
- `secrets` for sensitive data
- `profiles` for optional services

## Base pattern

```yaml
services:
  web:
    build:
      context: .
      target: development
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: development
    depends_on:
      db:
        condition: service_healthy
    networks:
      - app

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: dev
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - app

networks:
  app:
    driver: bridge

volumes:
  db-data:
```

## Development override

```yaml
services:
  web:
    volumes:
      - .:/app
      - /app/node_modules
    command: npm run dev
    environment:
      NODE_ENV: development
      CHOKIDAR_USEPOLLING: "true"
```

## Common patterns

### Internal network

```yaml
services:
  api:
    networks:
      - frontend
      - backend

  db:
    networks:
      - backend

networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge
    internal: true
```

### Optional services

```yaml
services:
  debug:
    image: alpine
    profiles:
      - debug
```

### Environment files

```yaml
services:
  api:
    env_file:
      - .env
      - .env.local
```

## Essential commands

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f web
docker compose exec web sh
docker compose run --rm web npm test
docker compose config
docker compose down -v
```

## Troubleshooting

- Services cannot communicate: check service names and network membership.
- Volumes are empty: check mount paths and permissions.
- Health checks fail: increase `start_period` and verify the probe command.
- Port conflicts happen: change the host port or stop the conflicting service.
- Reload does not work: use a bind mount and a dev command in the override file.

## Related skills

- `docker-guide` for Docker basics and debugging
- `dockerfile-optimizer` for build-time optimization
- `docker-production` for hardened production stacks
