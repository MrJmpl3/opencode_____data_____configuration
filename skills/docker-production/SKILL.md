---
name: docker-production
description: "Use when deploying Docker Compose applications to production with security hardening, resource management, logging, backups, monitoring, and resilience."
---

# Docker Compose Production Deployment

Use this skill for production Compose stacks that need hardening and operational safeguards.

## Use this skill for

- Security hardening
- Resource limits and restart policies
- Logging and log rotation
- Secrets and env management
- Backups and restore workflows
- Monitoring, observability, and resilience

## Do not use this skill for

- Local multi-service development. Use `docker-orchestration`.
- Dockerfile optimization. Use `dockerfile-optimizer`.

## Rules

- Use `docker compose`, not `docker-compose`.
- Use `compose.yaml` plus `compose.prod.yaml` for production overlays.
- Do not add `version:` to Compose files.

## Production baseline

```yaml
services:
  web:
    image: nginx:1.25-alpine
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /var/cache/nginx
      - /var/run
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
        reservations:
          cpus: "0.5"
          memory: 256M

  api:
    image: mycompany/api:${VERSION:-latest}
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    env_file:
      - .env.production
    secrets:
      - db_password
      - jwt_secret
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2G

secrets:
  db_password:
    file: ./secrets/db_password.txt
  jwt_secret:
    file: ./secrets/jwt_secret.txt
```

## Production patterns

### Resource controls

```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 4G
        reservations:
          cpus: "2.0"
          memory: 2G
    volumes:
      - postgres-data:/var/lib/postgresql/data
```

### Monitoring

```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:9090/-/healthy"]
      interval: 30s
      timeout: 10s
      retries: 3

  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    env_file:
      - .env.production
    secrets:
      - grafana_password
    volumes:
      - grafana-data:/var/lib/grafana
```

### Backups

```yaml
services:
  backup:
    image: prodrigestivill/postgres-backup-local:15-alpine
    restart: unless-stopped
    environment:
      SCHEDULE: "@daily"
      BACKUP_KEEP_DAYS: 7
      BACKUP_KEEP_WEEKS: 4
      BACKUP_KEEP_MONTHS: 6
    volumes:
      - ./backups:/backups
```

## Production checklist

- Pinned images where possible
- Non-root runtime
- Health checks on long-running services
- Resource limits and restart policies
- Log rotation configured
- Secrets externalized
- Backup and restore plan documented
- Monitoring endpoint available
- `docker compose config` passes before deploy

## Related skills

- `docker-orchestration` for service layout and local stacks
- `docker-best-practices` for image and runtime review
