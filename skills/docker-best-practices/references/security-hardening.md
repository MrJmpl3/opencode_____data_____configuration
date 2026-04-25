# Runtime Security

## Least-Privilege Runtime Flags

Apply to `docker run` and Docker Compose `deploy` / `security_opt`:

```bash
docker run \
  --user 1000:1000 \                          # Non-root UID:GID
  --cap-drop=ALL \                            # Drop ALL Linux capabilities
  --cap-add=NET_BIND_SERVICE \                # Only add what's needed
  --read-only \                               # Read-only root filesystem
  --tmpfs /tmp:noexec,nosuid,size=64m \       # Writable temp (no exec)
  --security-opt="no-new-privileges:true" \  # Block setuid/setgid escalation
  --memory="512m" \
  --cpus="1.0" \
  --pids-limit=200 \
  myapp
```

In Compose:
```yaml
services:
  app:
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp:noexec,nosuid,size=64m
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
```

## Capability Reference

Common capabilities and when to add them:

| Capability | Needed for |
|---|---|
| `NET_BIND_SERVICE` | Binding ports < 1024 |
| `CHOWN` | `chown` calls at runtime |
| `DAC_OVERRIDE` | Reading files regardless of permissions |
| `SETUID` / `SETGID` | su, sudo, setuid programs |
| `SYS_PTRACE` | Debuggers (development only) |
| `SYS_ADMIN` | mount, cgroups (avoid in production) |

Default capabilities added by Docker (all dropped with `--cap-drop ALL`): AUDIT_WRITE, CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, MKNOD, NET_BIND_SERVICE, NET_RAW, SETFCAP, SETGID, SETPCAP, SETUID, SYS_CHROOT.

## AppArmor (Linux)

```bash
# Check status
sudo aa-status

# Run with Docker's default AppArmor profile (enabled by default on supported distros)
docker run --security-opt apparmor=docker-default myapp

# Disable AppArmor for a container (avoid in production)
docker run --security-opt apparmor=unconfined myapp
```

## SELinux (RHEL/CentOS/Fedora)

```bash
# Check status
sestatus

# Volume with SELinux labels for containers
docker run -v /host/path:/container/path:z myapp   # Private label (container-only)
docker run -v /host/path:/container/path:Z myapp   # Shared label (multi-container)
```

## User Namespace Remapping

Remap root inside containers to an unprivileged user on the host:

```json
// /etc/docker/daemon.json
{
  "userns-remap": "default"
}
```

```bash
sudo systemctl restart docker
# Result: UID 0 inside container → unprivileged UID on host (e.g., 1000000)
```

## Enhanced Container Isolation (ECI) — Docker Desktop 4.38+

ECI adds an extra security layer restricting Docker socket access and container escape vectors.

**Enable:**
```bash
# Docker Desktop GUI: Settings > Security > Enhanced Container Isolation
# Or via CLI:
docker desktop settings set enhancedContainerIsolation=true
```

**Use for:**
- Multi-tenant development environments
- Security-critical applications
- Compliance requirements (PCI-DSS, HIPAA)
- Zero-trust architectures

**Caveats:**
- May break containers that mount Docker socket (`/var/run/docker.sock`)
- Test existing containers before enabling in team environments
- Requires Docker Desktop 4.38+ (Windows WSL2, macOS, Linux Desktop)

**Troubleshoot ECI:**
```bash
# Identify socket dependencies
docker inspect CONTAINER | grep -i socket

# If socket access is truly needed, document and add explicitly:
docker run -v /var/run/docker.sock:/var/run/docker.sock ...

# Disable temporarily to debug:
docker desktop settings set enhancedContainerIsolation=false
```

## Vulnerability Scanning

```bash
# Docker Scout (built-in)
docker scout cves myapp:latest
docker scout recommendations myapp:latest

# Trivy (open-source, CI-friendly)
trivy image myapp:latest
trivy image --severity HIGH,CRITICAL myapp:latest
trivy image --exit-code 1 --severity CRITICAL myapp:latest  # Fail CI on critical

# Grype
grype myapp:latest
```

**Integrate in CI/CD:**
```yaml
# GitHub Actions
- name: Scan image for vulnerabilities
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: myapp:${{ github.sha }}
    format: sarif
    exit-code: '1'
    severity: 'CRITICAL,HIGH'
```

## Docker Content Trust (Image Signing)

```bash
# Enable image signing (requires Notary)
export DOCKER_CONTENT_TRUST=1

# Push signed image
docker push myrepo/myapp:1.0.0

# Pull only signed images
docker pull myrepo/myapp:1.0.0
```

## Secrets at Runtime

### Docker Secrets (Swarm mode)

```bash
# Create from file
docker secret create db_password ./password.txt

# Create from stdin
echo "s3cr3t!" | docker secret create db_password -

# Use in service
docker service create --secret db_password myapp
# Accessible inside container at /run/secrets/db_password
```

### Mount Secrets via File at Runtime

```bash
docker run \
  -v /secure/secrets:/run/secrets:ro \
  myapp
```

### Environment File (non-sensitive only)

```bash
docker run --env-file /secure/.env myapp
# Never commit .env files
```

## Security Audit Commands

```bash
# Check Docker daemon configuration
docker info

# Inspect container security settings
docker inspect --format='{{.HostConfig.SecurityOpt}}' container_name
docker inspect --format='{{.HostConfig.CapDrop}}' container_name
docker inspect --format='{{.HostConfig.CapAdd}}' container_name

# List all running containers with their users
docker ps -q | xargs docker inspect -f '{{.Name}}: {{.Config.User}}'
```
