# Email Service Architecture

## Overview

This is a Node.js/TypeScript background service that processes email webhook notifications from a PostgreSQL message queue (PGMQ) and syncs email data to a Supabase database. The service integrates with Nylas API to fetch and manage email threads and messages.

## Core Architecture

The service runs **three parallel processors** simultaneously:

### 1. Webhook Processor
**File:** `src/queue-processor.ts`

Handles real-time webhook notifications from the email provider:
- **Notification Types:**
  - `message.created` - New message received
  - `message.updated` - Existing message modified
  - `thread.replied` - Thread received a reply
  - `grant.expired` - Email account authorization expired

- **Processing Flow:**
  1. Polls PGMQ queue every 5 seconds (configurable)
  2. Reads messages in batches (default: 10)
  3. Routes notifications to appropriate handlers
  4. Updates notification status in audit table
  5. Acknowledges/deletes processed messages

- **Features:**
  - Retry logic with max 3 attempts
  - Testing mode for debugging (messages not deleted)
  - Performance metrics logging
  - Error tracking with context

### 2. Backfill Processor
**File:** `src/backfill-processor.ts`

Orchestrates historical email discovery and queuing:
- **Functionality:**
  - Fetches threads from Nylas within specified date range (max 1 year)
  - Enforces 1-year cap to prevent overwhelming the system
  - Queues threads for individual processing
  - Handles deduplication against existing database records

- **Processing Phases:**
  1. **Orchestration Phase** (`backfill` status):
     - Fetches threads page by page from Nylas API
     - Checks each thread against database for duplicates
     - Stores thread metadata in `queued_threads` table
     - Saves checkpoint after each successful page
  
  2. **Transition Phase** (`thread_sync` status):
     - Bulk queues all discovered threads to PGMQ
     - Opens gate for thread sync processor

- **Checkpoint/Resume:**
  - Saves progress: `last_page_token`, `threads_queued`, `current_page`
  - Automatically resumes from last checkpoint on retry
  - Preserves checkpoint on failure for manual retry

- **Deduplication Strategy:**
  - In-memory cache for current session
  - Database lookup to check existing threads
  - Prevents duplicate queuing and processing

### 3. Thread Sync Processor
**File:** `src/thread-sync-processor.ts`

Syncs individual threads with all their messages:
- **Processing Flow:**
  1. Reads thread job from PGMQ queue
  2. Fetches complete thread details from Nylas
  3. Fetches all messages in the thread (limit: 100)
  4. Syncs each message using `NylasSync` class
  5. Updates thread status and statistics

- **Rate Limiting:**
  - Configurable delay between threads (default: 3000ms)
  - Configurable delay between messages (default: 1000ms)
  - Configurable delay between API calls (default: 200ms)

- **Error Handling:**
  - Max 5 retry attempts per thread
  - Continues processing other messages if one fails
  - Marks failed threads after retry limit exceeded

- **Grant ID Recovery:**
  - Auto-fetches missing grant_id from `support_inboxes` table
  - Critical fix for threads without grant_id in queue payload

## Data Sync Component

### NylasSync Class
**File:** `src/nylas-sync.ts`

Handles Nylas API integration and database synchronization:

**Key Methods:**

1. **`syncMessage(grantId, inboxId, messageId)`**
   - Checks if message exists in database
   - Fetches complete message from Nylas API
   - Determines if thread is new or existing
   - Routes to appropriate sync method

2. **`syncNewThread(grantId, inboxId, threadId)`**
   - Fetches complete thread details
   - Fetches all messages in thread
   - Inserts thread with duplicate check
   - Batch inserts messages with duplicate filtering

3. **`insertMessages(threadDbId, messages)`**
   - Batch checks for existing messages
   - Filters out duplicates
   - Logs detailed message information
   - Handles rate limiting with configurable delays

**Defensive Programming:**
- Double-checks for duplicates before insert
- Handles missing data gracefully
- Continues processing on individual failures
- Detailed logging for debugging

## Technology Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.3+
- **Database:** PostgreSQL (Supabase)
- **Message Queue:** PGMQ (PostgreSQL Message Queue)
- **Email API:** Nylas SDK v7.0.0
- **Development Tools:** tsx (hot reload), TypeScript compiler

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPABASE_URL` | - | Supabase project URL (required) |
| `SUPABASE_SERVICE_KEY` | - | Supabase service role key (required) |
| `NYLAS_API_KEY` | - | Nylas API key (required) |
| `NYLAS_API_URI` | `https://api.us.nylas.com` | Nylas API endpoint |
| `POLL_INTERVAL_MS` | `5000` | Webhook queue polling interval |
| `BATCH_SIZE` | `10` | Max messages per poll |
| `VISIBILITY_TIMEOUT` | `300` | Message visibility timeout (seconds) |
| `THREAD_DELAY_MS` | `3000` | Delay between processing threads |
| `MESSAGE_DELAY_MS` | `1000` | Delay between processing messages |
| `API_DELAY_MS` | `200` | Delay between API calls |
| `TESTING_MODE` | `false` | Enable testing mode (no deletions) |
| `LOG_LEVEL` | `info` | Logging level |

### Setup Instructions

1. **Install dependencies:**
   ```bash
   yarn install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Build the project:**
   ```bash
   yarn build
   ```

4. **Run the service:**
   ```bash
   # Development (with hot reload)
   yarn dev

   # Production
   yarn start
   ```

## Database Schema

### Main Tables

**Email Data:**
- `support_email_threads` - Thread metadata (subject, participants, etc.)
- `support_email_messages` - Individual messages with full content
- `support_inboxes` - Email account configurations
- `support_inbox_configurations` - Backfill settings and progress

**Tracking:**
- `support_webhook_notifications` - Webhook audit trail
- `queued_threads` - Backfill progress tracking
- `inbox_sync_stats` - Real-time sync statistics

### PGMQ Queues

- `nylas_webhook_notifications` - Real-time webhook queue
- `inbox_backfill_jobs` - Backfill orchestration queue
- `thread_sync_jobs` - Individual thread sync queue

### Key Database Functions

**Queue Operations:**
- `read_nylas_webhook_notifications()` - Read from webhook queue
- `acknowledge_webhook_notification()` - Mark webhook processed
- `queue_nylas_webhook_notification()` - Add webhook to queue

**Backfill Operations:**
- `queue_thread_sync()` - Queue thread for processing
- `transition_to_thread_sync()` - Change backfill phase
- `update_backfill_orchestration_progress()` - Update progress
- `acknowledge_backfill_job()` - Complete backfill job

**Thread Operations:**
- `insert_queued_thread_idempotent()` - Queue thread (no duplicates)
- `initialize_sync_stats()` - Create stats entry

## Processing Flow

### Real-time Webhook Flow

```
Webhook → PGMQ Queue → QueueProcessor
                              ↓
                      NotificationHandler
                              ↓
                          NylasSync
                              ↓
                    Database (Threads/Messages)
```

### Backfill Flow

```
Backfill Job → BackfillProcessor
                      ↓
              Fetch Threads (Nylas API)
                      ↓
              Check Duplicates
                      ↓
              Queue Threads (DB tracking)
                      ↓
              Transition to thread_sync
                      ↓
              Bulk Queue to PGMQ
                      ↓
              ThreadSyncProcessor
                      ↓
              Fetch Messages (Nylas API)
                      ↓
              Database (Threads/Messages)
```

## Deployment

### Docker Deployment (Recommended)

```dockerfile
FROM node:20-slim
WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile

# Copy compiled code
COPY dist ./dist

# Start service
CMD ["node", "dist/index.js"]
```

Build and run:
```bash
docker build -t email-service .
docker run -d \
  --env-file .env \
  --name email-service \
  email-service
```

### PM2 Deployment

```bash
# Start service
pm2 start dist/index.js --name email-service

# Save configuration
pm2 save

# Setup auto-restart
pm2 startup
```

### Environment-Specific Configurations

**Development:**
- Enable `TESTING_MODE=true` for debugging
- Use shorter polling intervals
- Enable verbose logging

**Production:**
- Disable testing mode
- Configure appropriate delays for rate limiting
- Monitor error rates and adjust retry limits
- Use process manager for automatic restarts

## Monitoring & Observability

### Logging

The service provides structured logging for:

- **Queue polling:** Message counts, polling activity
- **Processing start/end:** Message IDs, notification types
- **Success/failure:** Duration, error details
- **Performance metrics:** Processing time per message
- **Rate limiting:** Delay confirmations between operations

**Log Format:**
```
[Service] Starting Email Service...
[Processor] Processing 3 messages
[Handler] Processing message.created
[Sync] Synced message abc123 to thread xyz789
[Processor] Successfully processed message.created in 245ms
```

### Monitoring Queries

**Check backfill progress:**
```sql
SELECT 
  id,
  backfill_status,
  backfill_progress->>'threads_queued' as threads_queued,
  backfill_progress->>'current_page' as current_page,
  backfill_started_at
FROM support_inbox_configurations
WHERE backfill_status IN ('backfill', 'thread_sync', 'completed');
```

**Check sync statistics:**
```sql
SELECT 
  config_id,
  threads_total,
  threads_queued,
  threads_processing,
  threads_completed,
  threads_failed,
  messages_synced,
  last_updated
FROM inbox_sync_stats
ORDER BY last_updated DESC;
```

**Check queue metrics:**
```sql
-- Webhook queue
SELECT * FROM pgmq_public.metrics('nylas_webhook_notifications');

-- Backfill queue
SELECT * FROM pgmq_public.metrics('inbox_backfill_jobs');

-- Thread sync queue
SELECT * FROM pgmq_public.metrics('thread_sync_jobs');
```

**Find failed notifications:**
```sql
SELECT 
  id,
  notification_type,
  status,
  error_message,
  received_at
FROM support_webhook_notifications
WHERE status = 'error'
ORDER BY received_at DESC
LIMIT 100;
```

## Error Handling & Recovery

### Retry Strategy

**Webhook Processor:**
- Max 3 retries per message
- Exponential backoff via PGMQ visibility timeout
- Marks as failed after max retries
- Preserves error messages in audit table

**Thread Sync Processor:**
- Max 5 retries per thread
- Continues processing other messages on individual failures
- Deletes from queue after max retries

**Backfill Processor:**
- Max 3 retries per job
- Preserves checkpoint on failure
- Allows manual retry from last checkpoint

### Graceful Shutdown

The service handles shutdown signals:
- `SIGTERM` - Graceful termination
- `SIGINT` - User interrupt (Ctrl+C)
- `uncaughtException` - Unhandled errors
- `unhandledRejection` - Promise rejections

**Shutdown Process:**
1. Sets shutdown flag
2. Stops all three processors in parallel
3. Waits for current operations to complete
4. Logs shutdown confirmation
5. Exits cleanly

### Common Issues & Solutions

**No messages processing:**
```sql
-- Check queue exists
SELECT * FROM pgmq_public.queues();

-- Check queue has messages
SELECT * FROM pgmq_public.metrics('nylas_webhook_notifications');
```
- Verify environment variables are set
- Check Nylas API credentials
- Ensure PGMQ extension is installed

**Messages failing:**
- Check service logs for error details
- Query failed notifications table
- Verify Nylas API rate limits
- Check grant_id is valid and not expired

**High memory usage:**
- Reduce `BATCH_SIZE` to process fewer messages
- Increase `POLL_INTERVAL_MS` to poll less frequently
- Increase delays to slow down processing

**Backfill stuck:**
- Check `backfill_status` in configurations table
- Review checkpoint data in `backfill_progress`
- Query `queued_threads` table for progress
- Check PGMQ queue metrics for thread_sync_jobs

## Performance Optimization

### Rate Limiting Best Practices

**For high-volume inboxes:**
- Increase `THREAD_DELAY_MS` to 5000-10000ms
- Increase `MESSAGE_DELAY_MS` to 2000-3000ms
- Process threads one at a time

**For low-volume inboxes:**
- Decrease delays to speed up processing
- Can process multiple threads in parallel (requires code modification)

### Batch Processing

**Current limitations:**
- Webhook processor: Batch size configurable (default: 10)
- Thread processor: One thread at a time
- Message processing: Sequential within thread

**Optimization opportunities:**
- Parallel thread processing (requires PGMQ concurrency handling)
- Batch message inserts (already implemented)
- Connection pooling for database operations

## Development

### Project Structure

```
src/
├── index.ts                    # Entry point & graceful shutdown
├── config.ts                   # Configuration loading & validation
├── queue-processor.ts          # Webhook queue consumer
├── backfill-processor.ts       # Historical backfill orchestrator
├── thread-sync-processor.ts    # Individual thread processor
├── notification-handler.ts     # Notification routing
└── nylas-sync.ts              # Nylas API integration & sync logic

migrations/
├── README.md                   # Migration instructions
├── 002_track_thread_completion.sql
├── 003_create_inbox_sync_stats_table.sql
└── 004_fix_grant_id_preservation.sql
```

### Scripts

```bash
# Development with hot reload
yarn dev

# Type checking only
yarn type-check

# Build for production
yarn build

# Run production build
yarn start
```

### Testing Mode

Enable testing mode to debug without affecting the queue:

```bash
TESTING_MODE=true yarn dev
```

**Testing mode features:**
- Messages are NOT deleted from queue
- Full payload logging
- Messages become visible again after visibility timeout
- Useful for debugging notification handling

## Migration Guide

### Database Migrations

Located in `migrations/` directory. See `migrations/README.md` for detailed instructions.

**Key migrations:**
1. **002_track_thread_completion.sql** - Automatic completion tracking
2. **003_create_inbox_sync_stats_table.sql** - Real-time statistics
3. **004_fix_grant_id_preservation.sql** - Grant ID handling

**Applying migrations:**
```bash
# Using Supabase CLI
supabase db execute --file migrations/002_track_thread_completion.sql

# Or via Supabase Dashboard SQL Editor
```

## Security Considerations

### Credentials Management

- Store all sensitive credentials in environment variables
- Never commit `.env` file to version control
- Use service role key with minimal required permissions
- Rotate Nylas API keys regularly

### Database Access

- Use service role key only for backend operations
- Never expose service role key in frontend code
- Implement row-level security policies on tables
- Audit database access regularly

### Error Handling

- Sanitize error messages before logging
- Don't expose internal implementation details
- Log sensitive operations for audit trail
- Monitor for suspicious activity patterns

## License

MIT
