# Inbox Sync Stats Table

## Overview

The `inbox_sync_stats` table provides real-time visibility into email sync operations with proper indexing and type safety, replacing the previous JSONB-based approach.

## Table Schema

```sql
CREATE TABLE inbox_sync_stats (
  config_id UUID PRIMARY KEY,
  
  -- Thread tracking
  threads_total INT,           -- Total threads found by Nylas
  threads_queued INT,          -- Threads added to queue
  threads_processing INT,      -- Currently being processed
  threads_completed INT,       -- Successfully synced
  threads_failed INT,          -- Failed to sync
  
  -- Message tracking
  messages_total INT,          -- Estimated total messages
  messages_synced INT,         -- Messages successfully synced
  
  -- Timestamps
  sync_started_at TIMESTAMP,
  last_thread_at TIMESTAMP,
  sync_completed_at TIMESTAMP,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

## Available Functions

### 1. `initialize_sync_stats(config_id, threads_total)`
Initializes sync stats when a backfill starts.

```sql
SELECT initialize_sync_stats(
  'config-uuid-here',
  0  -- Initial threads_total (updated as threads are found)
);
```

### 2. `increment_threads_queued(config_id)`
Increments the queued threads counter.

```sql
SELECT increment_threads_queued('config-uuid-here');
```

### 3. `start_thread_processing(config_id)`
Marks a thread as currently processing.

```sql
SELECT start_thread_processing('config-uuid-here');
```

### 4. `acknowledge_thread_job(msg_id, config_id, messages_synced, success)`
Acknowledges a completed thread and updates all statistics.

```sql
SELECT acknowledge_thread_job(
  123,                 -- msg_id from queue
  'config-uuid-here',  -- config_id
  15,                  -- messages_synced
  true                 -- success (default true)
);
```

## Useful Queries

### Check Sync Progress

```sql
-- See all active syncs
SELECT 
  config_id,
  threads_completed,
  threads_queued,
  threads_processing,
  threads_failed,
  ROUND(threads_completed::numeric / NULLIF(threads_queued, 0) * 100, 2) as progress_pct,
  messages_synced,
  sync_started_at,
  NOW() - sync_started_at as duration
FROM inbox_sync_stats
WHERE sync_completed_at IS NULL
  AND sync_started_at IS NOT NULL;
```

### Find Stalled Syncs

```sql
-- Syncs with no recent activity
SELECT 
  config_id,
  threads_processing,
  last_thread_at,
  NOW() - last_thread_at as time_since_last_thread
FROM inbox_sync_stats
WHERE sync_completed_at IS NULL
  AND last_thread_at < NOW() - INTERVAL '10 minutes';
```

### Get Completion Statistics

```sql
-- Recently completed syncs
SELECT 
  config_id,
  threads_completed,
  threads_failed,
  messages_synced,
  sync_completed_at - sync_started_at as total_duration,
  sync_completed_at
FROM inbox_sync_stats
WHERE sync_completed_at > NOW() - INTERVAL '24 hours'
ORDER BY sync_completed_at DESC;
```

### Check Currently Processing Threads

```sql
-- How many threads are actively being processed
SELECT 
  config_id,
  threads_processing,
  threads_completed,
  threads_queued,
  last_thread_at
FROM inbox_sync_stats
WHERE threads_processing > 0;
```

### Calculate Success Rate

```sql
-- Success rate per configuration
SELECT 
  config_id,
  threads_completed,
  threads_failed,
  threads_queued,
  ROUND(
    threads_completed::numeric / 
    NULLIF(threads_completed + threads_failed, 0) * 100, 
    2
  ) as success_rate_pct
FROM inbox_sync_stats
WHERE threads_queued > 0;
```

### Monitor Performance

```sql
-- Average messages per thread and sync speed
SELECT 
  config_id,
  messages_synced,
  threads_completed,
  ROUND(messages_synced::numeric / NULLIF(threads_completed, 0), 2) as avg_messages_per_thread,
  EXTRACT(EPOCH FROM (sync_completed_at - sync_started_at)) as duration_seconds,
  ROUND(
    messages_synced::numeric / 
    NULLIF(EXTRACT(EPOCH FROM (sync_completed_at - sync_started_at)), 0),
    2
  ) as messages_per_second
FROM inbox_sync_stats
WHERE sync_completed_at IS NOT NULL;
```

## Dashboard Query

```sql
-- Comprehensive sync dashboard
SELECT 
  s.config_id,
  c.inbox_id,
  
  -- Progress
  s.threads_completed || '/' || s.threads_queued as thread_progress,
  s.threads_processing as active_threads,
  s.threads_failed as failed_threads,
  ROUND(s.threads_completed::numeric / NULLIF(s.threads_queued, 0) * 100, 1) as progress_pct,
  
  -- Messages
  s.messages_synced,
  
  -- Timing
  CASE 
    WHEN s.sync_completed_at IS NOT NULL 
    THEN s.sync_completed_at - s.sync_started_at
    ELSE NOW() - s.sync_started_at
  END as duration,
  s.last_thread_at,
  
  -- Status
  CASE
    WHEN s.sync_completed_at IS NOT NULL THEN 'Completed'
    WHEN s.threads_processing > 0 THEN 'Processing'
    WHEN s.last_thread_at < NOW() - INTERVAL '5 minutes' THEN 'Stalled'
    ELSE 'In Progress'
  END as status
  
FROM inbox_sync_stats s
JOIN support_inbox_configurations c ON c.id = s.config_id
WHERE s.sync_started_at IS NOT NULL
ORDER BY s.sync_started_at DESC;
```

## Monitoring Alerts

### Alert: Stalled Sync
```sql
-- Syncs with no activity for 10+ minutes
SELECT config_id, last_thread_at
FROM inbox_sync_stats
WHERE sync_completed_at IS NULL
  AND last_thread_at < NOW() - INTERVAL '10 minutes';
```

### Alert: High Failure Rate
```sql
-- Syncs with >10% failure rate
SELECT 
  config_id,
  threads_failed,
  threads_completed + threads_failed as total_processed,
  ROUND(threads_failed::numeric / (threads_completed + threads_failed) * 100, 1) as failure_rate
FROM inbox_sync_stats
WHERE (threads_completed + threads_failed) > 10
  AND threads_failed::numeric / (threads_completed + threads_failed) > 0.1;
```

## Migration from JSONB

The migration automatically copies existing data from `support_inbox_configurations.backfill_progress` JSONB field to the new table. After verifying the migration:

1. Apply migration: `003_create_inbox_sync_stats_table.sql`
2. Verify data copied correctly
3. Optionally drop the `backfill_progress` column (keep for backward compat initially)

## Indexes

The table includes these performance indexes:

- `idx_sync_stats_processing`: Fast lookup of actively processing syncs
- `idx_sync_stats_in_progress`: Quick filter for incomplete syncs
- `idx_sync_stats_completed`: Fast queries for completed syncs

## Example Workflow

```sql
-- 1. Backfill starts
SELECT initialize_sync_stats('config-123', 0);

-- 2. As threads are queued
SELECT increment_threads_queued('config-123');  -- Called for each thread

-- 3. Thread starts processing
SELECT start_thread_processing('config-123');

-- 4. Thread completes
SELECT acknowledge_thread_job(456, 'config-123', 25, true);

-- 5. Check progress
SELECT * FROM inbox_sync_stats WHERE config_id = 'config-123';
```

## Benefits Over JSONB

✅ **Fast queries** - Indexed columns vs JSONB extraction  
✅ **Type safety** - INT columns vs JSONB strings  
✅ **Visibility** - Easy SQL queries vs nested JSON  
✅ **Proper tracking** - `threads_processing` and `threads_failed` states  
✅ **Performance** - No JSONB parsing overhead  
✅ **Standard SQL** - Works with all BI/monitoring tools
