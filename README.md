# Nova Email Service

Background service for processing Nylas webhook notifications from PGMQ queue.

## Overview

This service processes email sync operations asynchronously with four concurrent processors:
- **QueueProcessor**: Real-time webhook notifications
- **BackfillProcessor**: Historical thread discovery and orchestration
- **ThreadSyncProcessor**: Individual thread message synchronization
- **CompletionMonitor**: Progress tracking and completion detection

## Prerequisites

- Node.js 20+
- Access to Supabase database with PGMQ extension
- Nylas API credentials

## Setup

1. **Install dependencies**
   ```bash
   yarn install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in:
   - `SUPABASE_URL`: Your Supabase project URL
   - `SUPABASE_SERVICE_KEY`: Your Supabase service role key
   - `NYLAS_API_KEY`: Your Nylas API key
   - `NYLAS_API_URI`: Nylas API URI (default: https://api.us.nylas.com)

3. **Build the project**
   ```bash
   yarn build
   ```

## Running

### All Processors Together (Monolithic)

**Development:**
```bash
yarn dev
```

**Production:**
```bash
yarn build
yarn start
```

### Individual Processors (Recommended for Production)

Run each processor as a separate service for better scalability and isolation:

**Development (separate terminals):**
```bash
# Terminal 1 - Webhook Processor
yarn dev:webhooks

# Terminal 2 - Backfill Processor
yarn dev:backfill

# Terminal 3 - Thread Sync Processor(s)
yarn dev:threads

# Terminal 4 - Completion Monitor
yarn dev:completion
```

**Production:**
```bash
# Build first
yarn build

# Then start each service
yarn start:webhooks    # Real-time webhook processing
yarn start:backfill    # Historical thread discovery
yarn start:threads     # Individual thread sync
yarn start:completion  # Progress tracking & completion
```

**Why separate services?**
- ✅ **Independent Scaling** - Run multiple thread processors for heavy workloads
- ✅ **Better Fault Isolation** - One processor crash doesn't affect others
- ✅ **Independent Deployment** - Update services without downtime
- ✅ **Resource Allocation** - Assign different resources per service
- ✅ **Real-time Progress** - Completion monitor provides live progress updates

## Architecture

### Four-Processor System

#### 1. Webhook Processor
- **Queue**: `nylas_webhook_notifications`
- **Purpose**: Process real-time webhook events from Nylas
- **Operations**:
  - message.created → Sync new message to database
  - message.updated → Update message in database
  - thread.replied → Sync thread metadata
  - grant.expired → Mark inbox as auth_expired
- **Retry**: Max 3 attempts

#### 2. Backfill Processor
- **Queue**: `inbox_backfill_jobs`
- **Purpose**: Orchestrate historical thread discovery
- **Process Flow**:
  1. Read backfill job from queue
  2. Fetch threads from Nylas (paginated, max 1 year)
  3. Deduplicate against existing threads
  4. Add new threads to `queued_threads` table
  5. Save checkpoint after each page (crash recovery)
  6. Transition to thread_sync phase
  7. Bulk queue threads to PGMQ
- **Retry**: Max 3 attempts with checkpoint preservation
- **Features**: Checkpoint recovery, date range validation, deduplication

#### 3. Thread Sync Processor
- **Queue**: `thread_sync_jobs`
- **Purpose**: Sync individual threads with all messages
- **Process Flow**:
  1. Read thread job from queue
  2. Resolve grant_id if missing
  3. Fetch thread details from Nylas
  4. Fetch all messages in thread
  5. Sync using NylasSync class
  6. Update queued_threads status (triggers auto-update stats)
- **Retry**: Max 5 attempts
- **Rate Limiting**: Configurable delays between API calls

#### 4. Completion Monitor
- **Polling**: Database tables (no queue)
- **Purpose**: Track progress and detect completion in real-time
- **Process Flow**:
  1. Poll active backfills every 5 seconds
  2. Query queued_threads for each config
  3. Calculate statistics (total, queued, processing, completed, failed)
  4. Update inbox_sync_stats with real-time progress
  5. Detect completion (all threads processed)
  6. Mark backfill as 'completed' in flux_inbox_configurations
- **Auto-Recovery Feature**: 
  - Scans completed backfills every 60 seconds (configurable)
  - Detects premature completions (completed status but threads still pending)
  - Automatically resets status back to 'thread_sync'
  - Clears completion timestamps
  - Logs recovery actions for auditing
- **Benefits**: 
  - Real-time progress for frontend progress bars
  - Reliable completion detection
  - Fault tolerance if triggers fail
  - Live monitoring of all active backfills
  - Self-healing for premature completions
  - Double-verification before marking complete

### Component Flow

```
┌─────────────────────────────────────────────────────────┐
│                   Nylas Webhook                         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         flux_webhook_notifications table                │
│         (audit log + PGMQ queue trigger)                │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  QueueProcessor        │
        │  (real-time sync)      │
        └────────┬───────────────┘
                 │
                 ▼
        ┌────────────────────────┐
        │  NotificationHandler   │
        │  (route by type)       │
        └────────┬───────────────┘
                 │
                 ▼
        ┌────────────────────────┐
        │  NylasSync             │
        │  (sync to DB)          │
        └────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              User Initiates Backfill                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│      flux_inbox_configurations (backfill_status)        │
│      Queue to inbox_backfill_jobs                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │  BackfillProcessor     │
        │  (orchestrate)         │
        └────────┬───────────────┘
                 │
                 ├─► Fetch threads from Nylas (paginated)
                 ├─► Deduplicate vs database
                 ├─► Add to queued_threads table
                 ├─► Save checkpoint (each page)
                 ├─► Transition to thread_sync
                 └─► Bulk queue to thread_sync_jobs
                     │
                     ▼
        ┌────────────────────────┐
        │  ThreadSyncProcessor   │
        │  (sync threads)        │
        └────────┬───────────────┘
                 │
                 ├─► Fetch thread + messages
                 ├─► Sync using NylasSync
                 └─► Update queued_threads
                     (trigger updates stats)
```

### Database Tables

- **flux_inboxes** - Connected email accounts with grant IDs
- **flux_email_threads** - Email conversation threads
- **flux_email_messages** - Individual email messages
- **flux_inbox_configurations** - Sync configuration and backfill status
- **flux_webhook_notifications** - Webhook event audit log
- **inbox_sync_stats** - Real-time sync progress tracking
- **queued_threads** - Thread processing queue with deduplication

### PGMQ Queues

- **nylas_webhook_notifications** - Real-time webhook events
- **inbox_backfill_jobs** - Historical sync jobs
- **thread_sync_jobs** - Individual thread sync jobs

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | 5000 | Milliseconds between queue polls |
| `BATCH_SIZE` | 10 | Max messages to process per poll |
| `VISIBILITY_TIMEOUT` | 300 | Seconds before message becomes visible again |
| `COMPLETION_CHECK_INTERVAL_MS` | 5000 | Milliseconds between completion checks |
| `ENABLE_AUTO_RECOVERY` | true | Enable automatic detection and recovery of premature completions |
| `RECOVERY_CHECK_INTERVAL_MS` | 60000 | Milliseconds between premature completion scans |
| `THREAD_DELAY_MS` | 3000 | Delay between thread processing |
| `MESSAGE_DELAY_MS` | 1000 | Delay between messages |
| `API_DELAY_MS` | 200 | Delay between API calls (rate limiting) |
| `TESTING_MODE` | false | Test without deleting from queue |
| `LOG_LEVEL` | info | Logging level |

## Database Functions

The service uses these PostgreSQL functions (from migrations):

### Queue Operations
- `flux_pgmq_send(queue_name, message, delay_seconds)` - Send message to queue
- `flux_pgmq_read(queue_name, visibility_timeout, qty)` - Read messages from queue
- `flux_pgmq_delete(queue_name, message_id)` - Delete message from queue
- `flux_pgmq_metrics(queue_name)` - Get queue metrics

### Webhook Operations
- `queue_nylas_webhook_notification(...)` - Queue webhook for processing
- `acknowledge_webhook_notification(...)` - Mark webhook as processed

### Backfill Operations
- `queue_inbox_backfill(...)` - Queue backfill job
- `insert_queued_thread_idempotent(...)` - Add thread to queue (idempotent)
- `transition_to_thread_sync(...)` - Move to thread sync phase
- `initialize_sync_stats(...)` - Initialize progress tracking

### Thread Sync Operations
- `queue_thread_sync(...)` - Queue thread for sync
- `update_backfill_orchestration_progress(...)` - Update progress

### Monitoring
- `get_sync_progress(config_id)` - Get detailed sync progress
- `get_webhook_metrics(time_window)` - Get webhook processing metrics

## Monitoring

### Check Sync Progress
```sql
SELECT * FROM get_sync_progress('config-id-here');
```

### Check Queue Metrics
```sql
SELECT * FROM flux_pgmq_metrics('nylas_webhook_notifications');
SELECT * FROM flux_pgmq_metrics('inbox_backfill_jobs');
SELECT * FROM flux_pgmq_metrics('thread_sync_jobs');
```

### Monitor Active Syncs
```sql
SELECT 
  config_id,
  backfill_status,
  threads_queued,
  threads_completed,
  threads_processing,
  threads_failed,
  messages_synced,
  ROUND((threads_completed::NUMERIC / threads_queued) * 100, 2) as percent_complete
FROM inbox_sync_stats
WHERE sync_completed_at IS NULL;
```

### Check Recent Webhook Activity
```sql
SELECT 
  notification_type,
  status,
  COUNT(*),
  AVG(processing_duration_ms) as avg_duration_ms
FROM flux_webhook_notifications
WHERE received_at > NOW() - INTERVAL '1 hour'
GROUP BY notification_type, status;
```

### Check Failed Operations
```sql
-- Failed webhooks
SELECT * FROM flux_webhook_notifications 
WHERE status = 'error'
ORDER BY received_at DESC 
LIMIT 10;

-- Failed threads
SELECT * FROM queued_threads
WHERE status = 'failed'
ORDER BY processed_at DESC
LIMIT 10;
```

## Deployment

### Docker Compose - Separate Services (Recommended)

Use the included `docker-compose.yml` to run all services:

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f threads

# Scale thread processors
docker-compose up -d --scale threads=5

# Stop all services
docker-compose down

# Restart specific service
docker-compose restart backfill
```

The docker-compose.yml runs:
- **1x webhooks** - Real-time webhook processing
- **1x backfill** - Historical thread discovery
- **2x threads** - Message sync (scalable)
- **1x completion** - Progress tracking & completion detection

### Docker - Single Container (Monolithic)

**Build:**
```bash
docker build -t nova-email-service .
```

**Run:**
```bash
docker run -d \
  --name nova-email-service \
  --env-file .env \
  --restart unless-stopped \
  nova-email-service
```

### PM2 - Separate Services (Recommended)

Run each processor as a separate PM2 process for better control:

```bash
# Install PM2
npm install -g pm2

# Build first
yarn build

# Start all four services
pm2 start dist/webhooks.js --name nova-webhooks
pm2 start dist/backfill.js --name nova-backfill
pm2 start dist/threads.js --name nova-threads
pm2 start dist/completion.js --name nova-completion

# Or scale thread processors
pm2 start dist/threads.js --name nova-threads --instances 3

# Save configuration
pm2 save

# Setup startup script
pm2 startup

# Monitor all services
pm2 status
pm2 logs

# Monitor specific service
pm2 logs nova-threads

# Scale thread processors on the fly
pm2 scale nova-threads 5

# Restart specific service
pm2 restart nova-backfill
```

### PM2 - Single Service (Original)

```bash
# Start all processors together
pm2 start dist/index.js --name nova-email-service
pm2 save
pm2 startup
```

## Development

### Type Checking
```bash
yarn type-check
```

### Project Structure
```
src/
├── index.ts                    # Entry point (all 4 processors)
├── webhooks.ts                 # Entry point (webhook processor only)
├── backfill.ts                 # Entry point (backfill processor only)
├── threads.ts                  # Entry point (thread sync processor only)
├── completion.ts               # Entry point (completion monitor only)
├── config.ts                   # Configuration loading & validation
├── queue-processor.ts          # PGMQ webhook polling
├── notification-handler.ts     # Notification routing
├── nylas-sync.ts              # Nylas API integration & sync
├── backfill-processor.ts      # Thread discovery orchestration
├── thread-sync-processor.ts   # Individual thread sync
└── completion-monitor.ts      # Progress tracking & completion
```

## Troubleshooting

### No messages processing

**Check if queues exist:**
```sql
SELECT * FROM flux_pgmq_list_queues();
```

**Check queue metrics:**
```sql
SELECT * FROM flux_pgmq_metrics('nylas_webhook_notifications');
```

**Solutions:**
- Verify PGMQ queues created (migration 003)
- Check environment variables
- Verify service is running: `pm2 status` or `docker ps`
- Check logs for errors

### Messages failing repeatedly

**Check error messages:**
```sql
SELECT error_message, COUNT(*)
FROM flux_webhook_notifications
WHERE status = 'error'
  AND received_at > NOW() - INTERVAL '24 hours'
GROUP BY error_message;
```

**Solutions:**
- Verify Nylas API credentials
- Check grant_id is valid
- Check Nylas rate limits
- Review error logs

### Backfill stuck

**Check backfill status:**
```sql
SELECT 
  backfill_status,
  backfill_started_at,
  backfill_progress
FROM flux_inbox_configurations
WHERE id = 'config-id';
```

**Check queued threads:**
```sql
SELECT status, COUNT(*)
FROM queued_threads
WHERE config_id = 'config-id'
GROUP BY status;
```

**Solutions:**
- Check if `transition_to_thread_sync` was called
- Verify thread_sync_jobs queue has messages
- Check ThreadSyncProcessor logs
- Verify grant_id is valid

### High memory usage

**Solutions:**
- Reduce `BATCH_SIZE` (default: 10)
- Increase `POLL_INTERVAL_MS` (default: 5000)
- Increase delays between processing
- Monitor with: `pm2 monit` or `docker stats`

### Rate Limiting Issues

If you see rate limit errors from Nylas:

**Solutions:**
- Increase `API_DELAY_MS` (default: 200)
- Increase `MESSAGE_DELAY_MS` (default: 1000)
- Increase `THREAD_DELAY_MS` (default: 3000)
- Process fewer threads concurrently

## Logging

The service logs:
- Processor lifecycle events
- Queue polling activity
- Message processing (start/success/failure)
- Errors with full context
- Performance metrics (processing duration)
- Progress indicators

**Log Format:**
```
[Component] Message with context
```

**Example:**
```
[Service] Starting Nova Email Service...
[Processor] Processing 3 messages
[Handler] Processing message.created
[Sync] Synced message abc123 to thread xyz789
[Processor] Successfully processed message.created in 245ms
[Monitor] Config 12345678... | Status: thread_sync | Progress: 75% (150/200)
```

## Error Handling

### Queue Messages
- Failed messages marked in database with error details
- Retry via PGMQ visibility timeout
- Max retries: 3 (webhooks), 5 (threads)
- After max retries, marked as failed and removed from queue

### Backfill Recovery
- Checkpoint saved after each page
- Resume from last checkpoint on restart
- Progress preserved on failure
- Manual retry possible with preserved checkpoint

### Graceful Shutdown
- Handles SIGTERM and SIGINT signals
- Stops all processors in parallel
- Allows in-flight operations to complete
- Safe for container orchestration

## Security

- Service role key for Supabase (full database access)
- Nylas API key for email access
- Store credentials in environment variables
- Never commit `.env` file to version control
- Use secrets management in production (e.g., AWS Secrets Manager, HashiCorp Vault)

## License

MIT
