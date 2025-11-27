# Backfill Error Loop Fix

## Problem
The system was experiencing an error loop where threads were being queued to PGMQ during the backfill phase (when status='backfill'), but ThreadSyncProcessor was checking the status and skipping them. After the 10-second visibility timeout, PGMQ would make the jobs visible again, creating an infinite loop.

Error messages:
```
[ThreadSync] Config ed28cc03-7df0-4b74-b431-fe215ce92a83 not in thread_sync status (current: backfill), skipping thread 19a7625d1da19b7a
```

## Root Cause
**Timing mismatch between orchestration and processing:**
- BackfillProcessor was queueing threads to PGMQ immediately as it discovered them
- ThreadSyncProcessor was rejecting them because the config was still in 'backfill' status
- Jobs weren't deleted, so they kept reappearing in PGMQ

## Solution
**Separate orchestration from processing by deferring PGMQ queueing:**

### Phase 1: Backfill (status='backfill')
- Only track threads in the `queued_threads` database table
- Do NOT queue to PGMQ yet

### Phase 2: Transition (status='thread_sync')
- Bulk queue all pending threads from `queued_threads` to PGMQ
- Now ThreadSyncProcessor can process them immediately

## Changes Made

### 1. BackfillProcessor (`src/backfill-processor.ts`)

**Modified `queueThreadWithDeduplication()`:**
- Removed immediate PGMQ queueing during backfill
- Only inserts threads into `queued_threads` table with `grant_id`

**Added `bulkQueueThreads()` method:**
- Called after transitioning to 'thread_sync' status
- Fetches all queued threads from database
- Queues them all to PGMQ in bulk
- Logs progress and success/failure counts

**Updated `processBackfillJob()`:**
- Calls `bulkQueueThreads()` after status transition
- Ensures all threads are queued before acknowledging the job

### 2. ThreadSyncProcessor (`src/thread-sync-processor.ts`)

**Removed status check:**
- Deleted the status validation that was rejecting threads
- No longer needed since threads only appear in PGMQ when ready to process
- Cleaner, simpler processing logic

## Benefits

1. **Eliminates error loop** - No more repeated skipping of threads
2. **Better separation of concerns** - Orchestration and processing are distinct phases
3. **Cleaner logs** - No more confusing status mismatch messages
4. **More efficient** - Threads processed immediately when queued
5. **Atomic transition** - All threads become available at once

## Testing Recommendations

1. **Monitor logs during backfill:**
   ```bash
   # Should see threads tracked but not queued to PGMQ during backfill
   [Backfill] Thread abc123 already queued in this session, skipping
   [Backfill] Queued 50 threads so far (page 3)
   ```

2. **Check transition logs:**
   ```bash
   [Backfill] Transitioned to thread_sync phase with 150 threads queued
   [Backfill] Bulk queueing threads to PGMQ for config ed28cc03...
   [Backfill] Queueing 150 threads to PGMQ...
   [Backfill] Successfully queued 150/150 threads to PGMQ
   ```

3. **Verify processing starts immediately:**
   ```bash
   [ThreadSync] Processing thread abc123 (attempt 1/5)
   [ThreadSync] Fetched thread details: Customer inquiry
   ```

4. **No more error messages:**
   - Should NOT see: "Config not in thread_sync status (current: backfill)"

## Database Schema Note

The `queued_threads` table now stores `grant_id` which is needed for PGMQ queueing. Ensure your migration includes this field.

## Rollback Plan

If issues arise, the old behavior can be restored by:
1. Re-adding immediate PGMQ queueing in `queueThreadWithDeduplication()`
2. Re-adding status check in ThreadSyncProcessor
3. Removing call to `bulkQueueThreads()`

However, this will bring back the error loop unless the backfill completes very quickly.
