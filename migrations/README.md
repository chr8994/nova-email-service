# Database Migrations

This directory contains SQL migration files for the Nova Email Service.

## Applying Migrations

To apply a migration, run the SQL file against your Supabase database using one of these methods:

### Method 1: Supabase Dashboard (Recommended)
1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor**
3. Create a new query
4. Copy and paste the contents of the migration file
5. Click **Run** to execute

### Method 2: Supabase CLI
```bash
supabase db execute --file migrations/002_track_thread_completion.sql
```

### Method 3: psql Command Line
```bash
psql "postgresql://[user]:[password]@[host]:5432/postgres" -f migrations/002_track_thread_completion.sql
```

## Available Migrations

### 002_track_thread_completion.sql
**Purpose:** Automatically track thread completion and update inbox configuration status

This migration updates the `acknowledge_thread_job` function to:
- Track how many threads have been completed vs queued
- Count total messages synced
- Automatically update the `backfill_status` to 'completed' when all threads finish
- Provide detailed logging for debugging

**When to apply:** Before running any backfill operations with the new version of the code

**Dependencies:** Requires the following database objects to exist:
- `support_inbox_configurations` table with columns:
  - `backfill_status` (text)
  - `backfill_progress` (jsonb)
  - `backfill_completed_at` (timestamp)
  - `updated_at` (timestamp)
- `pgmq_public.delete()` function (from PGMQ extension)
- `thread_sync_jobs` queue (created by PGMQ)

## How It Works

1. **Backfill Orchestration**: When a backfill starts, it:
   - Fetches all threads in the date range
   - Queues each thread for processing
   - Stores `threads_queued` count in `backfill_progress`

2. **Thread Processing**: Each thread is processed independently:
   - Fetches all messages in the thread
   - Syncs messages to database
   - Calls `acknowledge_thread_job()` when done

3. **Automatic Completion**: The `acknowledge_thread_job()` function:
   - Increments `threads_completed` counter
   - Compares to `threads_queued`
   - When all threads complete, sets status to 'completed'

## Monitoring Progress

Query the configuration table to see progress:

```sql
SELECT 
  id,
  backfill_status,
  backfill_progress->>'threads_queued' as threads_queued,
  backfill_progress->>'threads_completed' as threads_completed,
  backfill_progress->>'total_messages_synced' as total_messages,
  backfill_started_at,
  backfill_completed_at
FROM support_inbox_configurations
WHERE backfill_status IN ('in_progress', 'completed');
```

## Rollback

If you need to rollback this migration, you can restore the old function (though this is not recommended as it will break the automatic completion tracking).
