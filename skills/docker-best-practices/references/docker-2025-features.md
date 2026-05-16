# Docker 2025 Features

## Docker Engine 28 (2025)

### Image Type Mounts

Mount an image's filesystem directly inside a container as a read-only layer — no volume extraction needed:

```bash
# Mount entire image as read-only directory
docker run --rm \
  --mount type=image,source=mydata:latest,target=/data \
  alpine ls -la /data

# Mount a sub-path from an image
docker run --rm \
  --mount type=image,source=mydata:latest,image-subpath=/config,target=/app/config \
  alpine cat /app/config/settings.json
```

**In Compose:**

```yaml
services:
  app:
    volumes:
      - type: image
        source: mydata:latest
        target: /data
        read_only: true
```

**Use cases:**

- Read-only configuration distribution
- Shared ML model weights across containers
- Static asset serving without duplication
- Immutable test data sets

### Versioned Debug Endpoints

Debug endpoints now accessible via versioned API (Engine 28 / API v1.48+):

```bash
# Runtime variables
curl --unix-socket /var/run/docker.sock http://localhost/v1.48/debug/vars

# CPU profiling (30 seconds)
curl --unix-socket /var/run/docker.sock \
  "http://localhost/v1.48/debug/pprof/profile?seconds=30" > profile.out

# Goroutine stacks
curl --unix-socket /var/run/docker.sock http://localhost/v1.48/debug/pprof/goroutine
```

Available endpoints: `/v1.48/debug/vars`, `/v1.48/debug/pprof/`, `/v1.48/debug/pprof/cmdline`, `/v1.48/debug/pprof/profile`, `/v1.48/debug/pprof/trace`, `/v1.48/debug/pprof/goroutine`

### Engine 28 Component Versions

| Component     | Version |
| ------------- | ------- |
| Docker Engine | 28.x    |
| Buildx        | v0.26+  |
| Compose       | v2.40+  |
| BuildKit      | v0.25+  |
| Go runtime    | 1.24+   |

### Security Fix: CVE-2025-54388

**Impact:** Published container ports bound to loopback (`127.0.0.1`) could be accessed from local network after `firewalld` reload.

**Action:** Upgrade to Engine 28.x; review containers that bind to `127.0.0.1` expecting localhost-only access.

---

## Docker Desktop 4.47+ (October 2025)

### MCP Catalog Integration

100+ verified, containerized Model Context Protocol (MCP) server tools:

```bash
# Discover via Docker Hub MCP Catalog
# https://hub.docker.com/mcp-catalog

# Deploy directly from Docker Desktop MCP Toolkit
# or programmatically via Docker AI integration
```

### Model Runner

Run large language models locally with GPU acceleration:

```bash
# Run a model
docker model run llama2-7b

# List running models
docker model ls

# Inspect model details
docker model inspect llama2-7b

# Monitor inference requests (new in 4.47)
docker model requests llama2-7b

# Resource usage
docker stats $(docker model ls -q)
```

**Benefits:** No API costs, complete data privacy, offline availability, local GPU acceleration.

### Enhanced Container Isolation (ECI) Updates

- CVE-2025-10657 (v4.47): Fixed Docker Socket command restriction bypass from v4.46.
- CVE-2025-9074 (v4.46): Fixed container escape that allowed Engine access without mounted socket.

### Silent Component Updates

Docker Desktop now auto-updates internal components (Compose, BuildKit, Containerd) in the background without requiring full restart. Configure in Settings > General.

### Multi-Node Kubernetes (4.38+)

Test multi-node Kubernetes clusters locally with 2–5 nodes:

```
Docker Desktop → Settings → Kubernetes → Enable multi-node → Set node count
```

**Use for:** Testing pod scheduling, affinity rules, network policies, StatefulSets, DaemonSets.

---

## Docker Compose v2.40+ Breaking Changes & Features

### Version Field Obsolete

```yaml
# OLD (deprecated — field is now ignored)
version: '3.8'
services:
  app:
    image: nginx

# NEW (2025 standard)
services:
  app:
    image: nginx:1.27.0
```

**Action:** Remove `version` field from all `compose.yml` / `docker-compose.yml` files.

### New Features

**1. Develop watch with `initial_sync`**

```yaml
services:
  app:
    build: .
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
          initial_sync: full # Sync ALL files on container start
        - action: rebuild
          path: composer.json # Triggers image rebuild
        - action: sync+restart
          path: .env # Sync then restart container
```

**2. Volume type: image**

```yaml
services:
  app:
    volumes:
      - type: image
        source: mydata:latest
        target: /data
        read_only: true
```

**3. Debug build configs**

```bash
docker compose build --print > build-config.json
docker compose config --no-env-resolution     # Raw config, no var substitution
docker compose watch --prune                  # Prune unused resources during watch
docker compose run --quiet app npm test       # Suppress startup noise in CI
```

### Compose Bridge (convert to Kubernetes)

```bash
docker compose convert --format kubernetes > k8s-manifests.yaml
kubectl apply -f k8s-manifests.yaml
```

---

## BuildKit 2025 Features

### COPY / ADD `--exclude` (GA)

Previously labs-only, now generally available:

```dockerfile
# Exclude test files and docs from COPY
COPY --exclude=*.test.js --exclude=*.md --exclude=tests/ . /app

# ADD with chown and unpack
ADD --unpack=true --chown=appuser:appgroup archive.tar.gz /app
```

### Git clone in ADD with fine-grained control

```dockerfile
# Shallow clone specific branch
ADD https://github.com/user/repo.git?depth=1&branch=main /src

# Use SHA-256 based refs
ADD https://github.com/user/repo#sha256:abc123... /src
```

### Image Checksum Verification

```dockerfile
# Pin base image by digest for reproducible builds
FROM alpine:3.19@sha256:c5b1261d6d3e43071626931fc004f70149baeba2c8ec672bd4f27761f8e1ad6b
```

### Secure Frontend Declaration

```dockerfile
# Pin the Dockerfile syntax version
# syntax=docker/dockerfile:1

# Pin with digest for maximum security
# syntax=docker/dockerfile:1@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
```

---

## Recommended Feature Adoption Timeline

| Feature                             | Readiness        | Action                                   |
| ----------------------------------- | ---------------- | ---------------------------------------- |
| Remove `version` field from Compose | Production ready | Apply now                                |
| BuildKit cache mounts               | Production ready | Apply now                                |
| `COPY --exclude`                    | Production ready | Apply now                                |
| Engine 28 upgrade                   | Production ready | Update via package manager               |
| Image type volumes                  | Stable           | Evaluate for data distribution use cases |
| Compose `develop watch`             | Stable           | Adopt for local dev workflows            |
| Compose Bridge (K8s)                | Beta             | Evaluate for K8s migration paths         |
| Docker AI / Model Runner            | Beta             | Use for local AI development             |
| Enhanced Container Isolation        | Test thoroughly  | Validate existing containers first       |
| Multi-node Kubernetes               | Beta             | Pre-production testing only              |
