# Nova Email Service

Background service for processing Nylas webhook notifications from PGMQ queue.

## Overview

This service reads Nylas webhook notifications from a PostgreSQL PGMQ queue and processes them asynchronously. It handles:
- Message sync (create/update)
- Thread sync
- Grant expiration events
- Thread recovery for incomplete webhook payloads

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

### Development
```bash
yarn dev
```

### Production
```bash
yarn start
```

## Architecture

### Components

- **QueueProcessor**: Polls PGMQ queue for new webhook notifications
- **NotificationHandler**: Routes notifications to appropriate handlers
- **NylasSync**: Syncs messages and threads to Supabase database

### Flow

1. Webhook receives notification → queues to PGMQ
2. QueueProcessor reads from queue (polls every 5s by default)
3. NotificationHandler processes based on type
4. NylasSync syncs data to database
5. Acknowledges message in queue

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | 5000 | Milliseconds between queue polls |
| `BATCH_SIZE` | 10 | Max messages to process per poll |
| `VISIBILITY_TIMEOUT` | 300 | Seconds before message becomes visible again |
| `LOG_LEVEL` | info | Logging level |

## Database Functions

The service uses these PostgreSQL functions (created in odyssey-ui migration 054):

- `read_nylas_webhook_notifications(p_limit, p_visibility_timeout)`: Read from queue
- `acknowledge_webhook_notification(p_message_id, p_notification_id, p_success, p_error_message)`: Acknowledge processed message
- `queue_nylas_webhook_notification(...)`: Queue new notification (used by webhook)

## Monitoring

The service logs:
- Queue polling activity
- Message processing (start/success/failure)
- Errors with full context
- Performance metrics (processing duration)

### Logs Format

```
[Service] Starting Nova Email Service...
[Processor] Processing 3 messages
[Handler] Processing message.created
[Sync] Synced message abc123 to thread xyz789
[Processor] Successfully processed message.created in 245ms
```

## Error Handling

- Failed messages are marked as failed in the audit table
- Messages stay in queue for retry (based on PGMQ visibility timeout)
- Graceful shutdown on SIGTERM/SIGINT
- Uncaught exceptions logged and service exits

## Deployment

### Docker (Recommended)

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production --frozen-lockfile
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

### Process Manager (PM2)

```bash
pm2 start dist/index.js --name nova-email-service
pm2 save
```

## Development

### Type Checking
```bash
yarn type-check
```

### Project Structure
```
src/
├── index.ts              # Entry point & graceful shutdown
├── config.ts             # Configuration loading
├── queue-processor.ts    # PGMQ polling logic
├── notification-handler.ts  # Notification routing
└── nylas-sync.ts         # Nylas API integration & sync
```

## Troubleshooting

### No messages processing
- Check PGMQ queue exists: `SELECT * FROM nova_pgmq_list_queues();`
- Check queue has messages: `SELECT * FROM nova_pgmq_metrics('nylas_webhook_notifications');`
- Verify environment variables are set correctly

### Messages failing
- Check service logs for error details
- Query failed notifications: `SELECT * FROM support_webhook_notifications WHERE status = 'error';`
- Check Nylas API credentials and rate limits

### High memory usage
- Reduce `BATCH_SIZE` to process fewer messages at once
- Increase `POLL_INTERVAL_MS` to poll less frequently

## License

MIT
