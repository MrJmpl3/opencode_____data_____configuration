# Docker Debugging Techniques

## Logs

```bash
# Stream logs (follow)
docker logs -f container_name
docker compose logs -f service_name

# Last N lines
docker logs --tail 100 container_name

# Since timestamp
docker logs --since 2025-01-01T10:00:00 container_name

# With timestamps
docker logs -t container_name
```

## Shell Access

```bash
# Interactive shell in running container
docker exec -it container_name /bin/sh
docker exec -it container_name /bin/bash   # If bash is available

# Run as root to debug (override USER in Dockerfile)
docker exec -u root -it container_name /bin/sh

# Shell in a new container (does not start CMD)
docker run -it --entrypoint /bin/sh image_name

# Override entrypoint for a stopped/broken image
docker run -it --entrypoint /bin/sh --rm image_name
```

## Inspect Container State

```bash
# Full JSON details
docker inspect container_name

# Exit code (useful when container dies immediately)
docker inspect -f '{{.State.ExitCode}}' container_name

# Environment variables
docker inspect -f '{{.Config.Env}}' container_name

# Mounted volumes
docker inspect -f '{{.Mounts}}' container_name

# IP address
docker inspect -f '{{.NetworkSettings.IPAddress}}' container_name
```

## Resource Monitoring

```bash
# Real-time CPU/memory/network stats (all containers)
docker stats

# Single container
docker stats container_name

# One-time snapshot (no streaming)
docker stats --no-stream

# Check disk usage
docker system df
```

## Build Debugging

```bash
# Build with no cache (force rebuild all layers)
docker build --no-cache -t myapp .

# Verbose build output (shows all commands)
docker build --progress=plain -t myapp .

# Build only up to a specific stage (multi-stage)
docker build --target builder -t myapp-builder .

# Inspect layer history and sizes
docker history myapp:latest

# Inspect image filesystem
docker run --rm -it myapp sh
```

## Network Debugging

```bash
# List networks
docker network ls

# Inspect network (connected containers, subnets)
docker network inspect bridge
docker network inspect compose_project_default

# Test connectivity between containers
docker exec container1 ping container2
docker exec container1 wget -O- http://container2:8080/health

# Test DNS resolution in container
docker exec container_name nslookup db
docker exec container_name curl -v http://api:8000/health

# Port mapping check
docker port container_name
```

## Common Failure Scenarios

### Container exits immediately
```bash
# Check logs immediately after crash
docker logs container_name

# Check exit code
docker inspect -f '{{.State.ExitCode}}' container_name
# Exit 1 = application error
# Exit 137 = OOM killed (increase memory limit)
# Exit 143 = SIGTERM (container stopped normally but too fast)

# Debug by overriding command
docker run -it --entrypoint /bin/sh image_name
```

### Port already in use
```bash
lsof -i :8080
kill -9 <PID>
# Or map to a different host port
docker run -p 9090:8080 myapp
```

### Volume appears empty / bind mount wrong path
```bash
docker inspect -f '{{.Mounts}}' container_name
# Verify the Source path exists on the host
ls -la /path/on/host
```

### MySQL/PostgreSQL won't start
```bash
docker logs db_container
# Common causes:
# - MYSQL_ROOT_PASSWORD not set
# - Data directory has wrong permissions
# - Port 3306 already in use on host

# Inspect the data volume
docker run --rm -v db_data:/data alpine ls -la /data
```

### Cannot connect between containers
```bash
# Check they share the same network
docker inspect container1 | grep -A 20 "Networks"
docker inspect container2 | grep -A 20 "Networks"

# Test connectivity
docker exec container1 ping container2

# Verify service name matches network alias
# In compose, the service name IS the hostname
```

### Build context too large / slow builds
```bash
# Check context size
du -sh .

# Review .dockerignore
cat .dockerignore

# Create comprehensive .dockerignore
cat > .dockerignore << 'EOF'
.git
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
docker-compose.override.yml
EOF
```

### OOM (Out of Memory) killed containers
```bash
# Identify OOM kill in logs
docker inspect -f '{{.State.OOMKilled}}' container_name
# Returns true if killed by OOM

# Increase memory limit
docker run -m 1g myapp

# Or in compose
services:
  app:
    deploy:
      resources:
        limits:
          memory: 1G
```

## Prune / Cleanup

```bash
# Remove all stopped containers, unused networks, dangling images, build cache
docker system prune

# Also remove unused volumes (WARNING: data loss possible)
docker system prune -a --volumes

# Individual cleanup
docker container prune   # Stopped containers
docker image prune       # Dangling images
docker image prune -a    # All unused images
docker volume prune      # Unused volumes
docker network prune     # Unused networks
docker builder prune     # BuildKit cache
```
