# Docker Deployment Guide

This service supports flexible Docker deployment using the `WORKER_TYPE` environment variable to run specific workers or all workers in a single container.

## Architecture

The service consists of 6 independent workers:
1. **webhooks** - Real-time webhook notifications
2. **backfill** - Historical thread discovery orchestration
3. **threads** - Individual thread message sync (scalable)
4. **completion** - Tracks progress and marks backfills complete
5. **extraction-queue** - Queues messages for AI extraction
6. **extraction** - Processes messages with LLM (scalable)

## Deployment Modes

### 1. Microservices Mode (Recommended for Production)

Each worker runs in its own container using the `WORKER_TYPE` environment variable:

```bash
# Start all workers as separate services
docker-compose up -d

# This runs:
# - 1 webhook processor
# - 1 backfill processor  
# - 2 thread sync processors (scaled)
# - 1 completion monitor
# - 1 extraction queue processor
# - 2 extraction workers (scaled)
```

### 2. Monolithic Mode (Development)

Run all workers in a single container:

```bash
# Without WORKER_TYPE or with WORKER_TYPE=all
docker run -e WORKER_TYPE=all --env-file .env your-image

# Or locally with Node
yarn start    # Runs all 6 workers
```

## Scaling Workers

Some workers can be scaled horizontally for increased throughput:

```bash
# Scale thread processors to 5 instances
docker-compose up -d --scale threads=5

# Scale extraction workers to 10 instances (for high-volume LLM processing)
docker-compose up -d --scale extraction=10
```

Workers that should NOT be scaled:
- `webhooks` - Single instance to prevent duplicate processing
- `backfill` - Single instance to coordinate discovery
- `completion` - Single instance to prevent race conditions
- `extraction-queue` - Single instance to prevent duplicate queuing

## Docker Compose Configuration

```yaml
services:
  webhooks:
    build: .
    environment:
      - WORKER_TYPE=webhooks
    env_file: .env
    
  extraction:
    build: .
    environment:
      - WORKER_TYPE=extraction
    env_file: .env
    deploy:
      replicas: 2  # Scale as needed
```

## Kubernetes Deployment

For Kubernetes, use separate Deployments for each worker:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nova-extraction-worker
spec:
  replicas: 5  # Scale as needed
  template:
    spec:
      containers:
      - name: extraction
        image: nova-email-service:latest
        env:
        - name: WORKER_TYPE
          value: extraction
        envFrom:
        - secretRef:
            name: nova-secrets
```

## Building the Image

```bash
# Build the Docker image
docker build -t nova-email-service:latest .

# The Dockerfile compiles TypeScript and creates a single image
# that can run any worker based on WORKER_TYPE
```

## Environment Variables

Set `WORKER_TYPE` to control which worker runs:

```bash
# .env file or docker-compose.yml
WORKER_TYPE=webhooks      # Webhook processor only
WORKER_TYPE=backfill      # Backfill processor only
WORKER_TYPE=threads       # Thread sync processor only
WORKER_TYPE=completion    # Completion monitor only
WORKER_TYPE=extraction-queue  # Extraction queue processor only
WORKER_TYPE=extraction    # Extraction worker only
WORKER_TYPE=all          # All workers (default if not set)
```

## Monitoring

View logs for specific workers:

```bash
# View logs for webhook processor
docker-compose logs -f webhooks

# View logs for all extraction workers
docker-compose logs -f extraction

# View logs for all services
docker-compose logs -f
```

## Resource Considerations

**Memory Requirements:**
- Webhooks: ~128MB
- Backfill: ~128MB
- Threads: ~256MB each (scales with Nylas API calls)
- Completion: ~128MB
- Extraction Queue: ~128MB
- Extraction: ~512MB each (LLM processing overhead)

**Recommended Production Setup:**
```bash
# High-volume email processing
webhooks: 1 instance
backfill: 1 instance
threads: 3-5 instances
completion: 1 instance
extraction-queue: 1 instance
extraction: 5-10 instances (based on LLM throughput)
```

## Graceful Shutdown

All workers handle SIGTERM/SIGINT for graceful shutdown:

```bash
# Gracefully stop all services
docker-compose down

# Gracefully stop specific service
docker-compose stop extraction
```

## Health Checks

Add health checks to docker-compose.yml:

```yaml
extraction:
  healthcheck:
    test: ["CMD", "node", "-e", "process.exit(0)"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 40s
```

## Development Workflow

```bash
# Local development (all workers)
yarn dev

# Local development (single worker)
yarn dev:extraction

# Build for production
yarn build

# Test Docker build locally
docker-compose up --build

# Deploy to production
docker-compose -f docker-compose.prod.yml up -d
