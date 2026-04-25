---
name: docker-best-practices
description: "Use when auditing Dockerfiles and Compose files with a checklist-style review for security, image hygiene, and production readiness."
---

# Docker Best Practices

## Review workflow

This skill is review-first: it identifies gaps and recommends fixes without redesigning the stack.

- Audit Dockerfile layer order: least-changed → most-changed.
- Replace `latest` tags with pinned versions everywhere.
- Verify the image runs as non-root (`USER` instruction present).
- Scan for vulnerabilities: `docker scout cves image:tag` or `trivy image image:tag`.
- Add `HEALTHCHECK` to every long-running container.
- Configure log rotation and resource limits before going to production.
- Run the production checklist before each deployment.

## Use this quick start

```bash
# Build and tag image with explicit version
docker build -t myapp:1.0.0 .

# Security and quality checks
docker scout cves myapp:1.0.0
docker run --rm myapp:1.0.0 --help

# Validate compose configuration
docker compose config
```

## Image audit

### Base image hierarchy (2025)

Prefer in this order:
1. **Chainguard / Wolfi** (`cgr.dev/chainguard/php:latest`) — zero-CVE goal, SBOM included
2. **Alpine** (`php:8.2-fpm-alpine`) — ~7 MB, minimal attack surface
3. **Distroless** (`gcr.io/distroless/base`) — no shell, ~2 MB runtime
4. **Slim** (`node:20-slim`) — ~70 MB, good balance for most use cases

### Layer optimization

```dockerfile
# Combine all related commands in a single RUN
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpng-dev \
        libzip-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Bad: 3 layers, cleanup layer doesn't shrink previous ones
RUN apt-get update
RUN apt-get install -y libpng-dev
RUN rm -rf /var/lib/apt/lists/*
```

### Non-root user

```dockerfile
# Alpine
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Debian/Ubuntu
RUN groupadd -r appuser && useradd -r -g appuser appuser
COPY --chown=appuser:appuser . /app
USER appuser
```

### .dockerignore (always required)

```
.git
.gitignore
node_modules
vendor
*.log
.env
.env.*
storage/logs/*
storage/framework/cache/*
storage/framework/sessions/*
storage/framework/views/*
bootstrap/cache/*
coverage/
dist/
.vscode/
.idea/
compose.override.yaml
```

## Runtime audit

```bash
docker run \
  --user 1000:1000 \
  --cap-drop=ALL \
  --cap-add=NET_BIND_SERVICE \
  --read-only \
  --tmpfs /tmp:noexec,nosuid \
  --security-opt="no-new-privileges:true" \
  --memory="512m" \
  --cpus="1.0" \
  myapp
```

### Secrets management

```dockerfile
# BAD: Secret embedded in image layer history
ENV API_KEY=secret123
RUN echo "password" > /app/config
```

```yaml
# GOOD: Docker secrets (Swarm)
services:
  app:
    secrets:
      - db_password
    environment:
      - DB_PASSWORD_FILE=/run/secrets/db_password

secrets:
  db_password:
    external: true
```

```yaml
# GOOD: env_file (never commit .env)
services:
  app:
    env_file:
      - .env.production   # gitignored
```

## Production audit

### Image tagging strategy

```bash
# Semantic version + git SHA for traceability
myapp:1.2.3
myapp:1.2.3-abc123f
myapp:1.2-staging

# Never tag only as 'latest' in production
```

### Health checks in Compose

```yaml
services:
  app:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s

  db:
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
```

### Graceful shutdown

```dockerfile
# Use exec form (signals reach the process directly)
CMD ["php-fpm"]          # Correct: PID 1 receives SIGTERM

# Avoid shell form (shell intercepts signals)
CMD php-fpm              # Wrong: /bin/sh PID 1, php-fpm PID 2+
```

### Linux daemon.json (production hardening)

```json
{
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true,
  "userland-proxy": false,
  "userns-remap": "default",
  "icc": false
}
```

## Production readiness checklist

- [ ] Base image has a pinned version tag (no `latest`)
- [ ] Multi-stage build separates build tools from runtime
- [ ] Container runs as non-root user
- [ ] No secrets in Dockerfile or image layers
- [ ] `.dockerignore` excludes development files
- [ ] Vulnerability scan passed (Docker Scout or Trivy)
- [ ] `HEALTHCHECK` implemented
- [ ] Resource limits defined (`memory`, `cpus`)
- [ ] Log rotation configured (`max-size`, `max-file`)
- [ ] Graceful shutdown handled (exec form CMD, SIGTERM handler in app)
- [ ] Image tagged with version + git SHA
- [ ] Tested on target platform (Linux amd64/arm64)

## Enforce these rules

- Always specify exact version tags for base images; never use `latest`.
- Always clean up package manager caches in the same `RUN` layer where they are created.
- Never store secrets in environment variables baked into images; use Docker secrets or external secret managers.
- Always implement `HEALTHCHECK` so orchestrators can detect unhealthy containers.
- Always use the exec form for `CMD` and `ENTRYPOINT` to ensure signals are forwarded correctly.

## Verify results

- Base image policy passes grep check: `grep -R "^FROM .*:latest" Dockerfile*` returns no production hits.
- Least-privilege runtime is enforceable with `docker inspect` checks for `Config.User`, `HostConfig.CapDrop`, and `HostConfig.ReadonlyRootfs`.
- Secret hygiene is verifiable: no credentials in Dockerfile/history via `docker history --no-trunc <image>` and runtime secrets via env/secrets files.
- Resilience controls exist and validate with `docker compose config` (healthcheck, restart policy, logging opts, cpu/memory limits).
- Security gate is executable in CI: `docker scout cves <image>` or `trivy image --exit-code 1 --severity CRITICAL,HIGH <image>`.
- 2025 readiness checks are present: Compose v2 syntax (`docker compose config` without `version`), BuildKit enabled (`DOCKER_BUILDKIT=1`), and updated feature references.

## Read this reference when needed

- `.agents/skills/docker-best-practices/references/security-hardening.md` — runtime security, capability management, AppArmor/SELinux, Enhanced Container Isolation (ECI)
- `.agents/skills/docker-best-practices/references/build-runtime-performance.md` — BuildKit cache mounts, image size reduction, build performance tuning
- `.agents/skills/docker-best-practices/references/docker-2025-features.md` — Docker Engine 28, Desktop 4.47, Compose v2.40 breaking changes and new features, BuildKit 2025

## Consult related skills

- `docker-guide` — core Docker concepts, Dockerfile fundamentals, Compose basics, debugging
