# Build and Runtime Performance

## BuildKit Cache Mounts

Persist package manager caches across builds without including them in the image:

```dockerfile
# syntax=docker/dockerfile:1

# PHP Composer
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --prefer-dist

# Python pip
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-cache-dir -r requirements.txt

# Node.js npm
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# APT packages
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libpng-dev \
        libzip-dev
```

Enable BuildKit:

```bash
export DOCKER_BUILDKIT=1
# Or set in /etc/docker/daemon.json:
{"features": {"buildkit": true}}
```

## Build Bind Mounts (avoid COPY for deps)

```dockerfile
# Mount package files without COPY-ing them (faster, no intermediate layers)
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci
```

## Multi-Platform Builds

```bash
# Create a multi-platform builder
docker buildx create --name multiplatform --driver docker-container --use

# Build for amd64 and arm64 simultaneously
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t myapp:1.0.0 \
  --push \
  .

# Build for current platform only (load into local daemon)
docker buildx build --platform linux/amd64 --load -t myapp:local .
```

## Docker Bake (GA in 2025)

Define complex multi-target builds in `docker-bake.hcl`:

```hcl
# docker-bake.hcl
variable "TAG" {
  default = "latest"
}

group "default" {
  targets = ["app", "worker"]
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  tags       = ["myapp:${TAG}"]
  platforms  = ["linux/amd64", "linux/arm64"]
  cache-from = ["type=registry,ref=myapp:cache"]
  cache-to   = ["type=registry,ref=myapp:cache,mode=max"]
}

target "worker" {
  inherits = ["app"]
  target   = "worker"
  tags     = ["myapp-worker:${TAG}"]
}

target "test" {
  inherits = ["app"]
  target   = "test"
  output   = ["type=local,dest=./coverage"]
}
```

```bash
# Build all targets
docker buildx bake

# Build specific target
docker buildx bake test

# Override variable
TAG=1.2.3 docker buildx bake

# Debug: print resolved config
docker buildx bake --print
```

## Image Size Reduction

| Technique                 | Typical saving |
| ------------------------- | -------------- |
| Alpine vs Debian base     | 100→5 MB base  |
| Multi-stage build         | 500→100 MB     |
| Remove build tools        | 30-50%         |
| `--no-cache-dir` (pip)    | 20-30%         |
| `--only=production` (npm) | 50-70%         |
| Combine RUN layers        | 5-15%          |

**Analyze image layers:**

```bash
# Layer sizes
docker history myapp:latest

# Detailed image analysis
docker run --rm -it \
  -v /var/run/docker.sock:/var/run/docker.sock \
  wagoodman/dive myapp:latest
```

## Volume Performance on macOS

```yaml
# Use delegated/cached mounts (reduces sync overhead)
services:
  app:
    volumes:
      - ./src:/app/src:delegated # Host writes delayed (best for source code)
      - ./build:/app/build:cached # Container writes cached (build outputs)

  # Keep node_modules/vendor in named volume (much faster than bind mount)
  node:
    volumes:
      - ./src:/app/src:delegated
      - node_modules:/app/node_modules # Named volume, no bind mount overhead

volumes:
  node_modules:
```

## CI/CD Registry Caching

```yaml
# GitHub Actions with BuildKit registry cache
- name: Build and push
  uses: docker/build-push-action@v5
  with:
    context: .
    push: true
    tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

```yaml
# GitLab CI with registry cache
build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  variables:
    DOCKER_BUILDKIT: "1"
  script:
    - docker buildx create --use
    - docker buildx build
      --cache-from type=registry,ref=$CI_REGISTRY_IMAGE:cache
      --cache-to type=registry,ref=$CI_REGISTRY_IMAGE:cache,mode=max
      --push
      -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
      .
```

## Slow Build Diagnosis

```bash
# Enable verbose output to see where time is spent
docker build --progress=plain -t myapp . 2>&1 | tee build.log

# Build without cache to get baseline timing
time docker build --no-cache -t myapp .

# Inspect what's in the build context (large context = slow transfer)
du -sh . && du -sh */ | sort -rh | head -20
cat .dockerignore

# Check for unnecessary file copies
docker build --progress=plain -t myapp . 2>&1 | grep "COPY\|ADD"
```

## Runtime Performance Tuning

```dockerfile
# Use exec form to avoid shell overhead for CMD/ENTRYPOINT
CMD ["node", "server.js"]   # Correct
CMD node server.js           # Wraps in /bin/sh -c

# PHP-FPM: tune workers in config
[www]
pm = dynamic
pm.max_children = 20
pm.start_servers = 5
pm.min_spare_servers = 3
pm.max_spare_servers = 10

# Ensure opcache is enabled in PHP
RUN echo "opcache.enable=1\nopcache.memory_consumption=256\nopcache.max_accelerated_files=20000\nopcache.validate_timestamps=0" \
    >> /usr/local/etc/php/conf.d/opcache.ini
```
