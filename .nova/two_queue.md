# Email Backfill Queue Architecture

## Executive Summary

This document outlines the architecture for implementing a scalable, queue-based email backfill system that processes historical emails while maintaining responsiveness for real-time webhook notifications.

---

## Current System

```
┌──────────────────────────────────┐
│  Webhook Notifications Queue     │
│  (nylas_webhook_notifications)   │
└──────────┬───────────────────────┘
           │
           ▼
    QueueProcessor
    - Processes message.created
    - Processes message.updated  
    - Real-time sync
```

---

## Proposed Architectures

### Option A: Two-Queue System (RECOMMENDED)

```
┌──────────────────────────────────┐
│  inbox_backfill_jobs             │ (1 job per inbox)
│  - inbox_id                      │
│  - config_id                     │
│  - grant_id                      │
│  - date_range                    │
└──────────┬───────────────────────┘
           │
           ▼
   BackfillProcessor
   (Orchestrator)
   - Fetches thread IDs via GET /threads
   - Queues each thread ID
   - Updates inbox-level progress
           │
           ▼
┌──────────────────────────────────┐
│  thread_sync_jobs                │ (Many jobs - 1 per thread)
│  - thread_id                     │
│  - grant_id                      │
│  - inbox_id                      │
│  - config_id                     │
└──────────┬───────────────────────┘
           │
           ▼
   ThreadSyncProcessor(s)
   (Workers - can run multiple)
   - GET /threads/{thread_id}
   - GET /messages?thread_id={thread_id}
   - Sync thread + all messages together
   - Update thread-level progress
```

**Pros:**
- ✅ Moderate complexity (3 processors total)
- ✅ Thread context maintained
- ✅ Good parallelization (multiple thread processors)
- ✅ Efficient (one API call for all messages in thread)
- ✅ Webhook queue processes between threads
- ✅ Good for 1,000-100,000+ messages

**Cons:**
- ❌ Large threads block for longer
- ❌ Can't parallelize within a thread

---

### Option B: Three-Queue System (MAXIMUM SCALE)

```
┌──────────────────────────────────┐
│  inbox_backfill_jobs             │ (1 job per inbox)
└──────────┬───────────────────────┘
           │
           ▼
   BackfillProcessor
   - Fetches thread IDs
   - Queues threads
           │
           ▼
┌──────────────────────────────────┐
│  thread_sync_jobs                │ (Many jobs - 1 per thread)
└──────────┬───────────────────────┘
           │
           ▼
   ThreadSyncProcessor(s)
   - GET /threads/{thread_id}
   - Fetches message IDs
   - Queues each message ID
           │
           ▼
┌──────────────────────────────────┐
│  message_sync_jobs               │ (MANY jobs - 1 per message)
└──────────┬───────────────────────┘
           │
           ▼
   MessageSyncProcessor(s)
   - GET /messages/{message_id}
   - Syncs individual message
```

**Pros:**
- ✅ Maximum granularity
- ✅ Ultimate parallelization
- ✅ Best rate limit control
- ✅ Finest-grained failure recovery
- ✅ Can scale to millions of messages

**Cons:**
- ❌ High complexity (4 processors total)
- ❌ Massive DB overhead (queue ops per message)
- ❌ Loses thread context
- ❌ Slower for typical use cases
- ❌ More difficult to debug/monitor

---

## Recommendation: Two-Queue System

### Rationale

1. **Sweet spot for scalability** - Handles 100,000+ messages efficiently
2. **Maintains thread context** - Messages processed together
3. **Good parallelization** - Multiple ThreadSyncProcessors
4. **Webhook responsiveness** - Queue processes between each thread
5. **Manageable complexity** - 3 processors is reasonable
6. **Can evolve** - Can add message queue later if needed

### When to use Three-Queue

Only if you have:
- Millions of messages per inbox
- Extreme API rate limiting requirements
- Need to distribute across multiple machines
- Complex per-message retry logic

---

## Implementation Plan: Two-Queue System

### Phase 1: Database Setup

#### 1.1 Create PGMQ Queue

```sql
-- Create thread sync queue
SELECT pgmq.create('thread_sync_jobs');
```

#### 1.2 Database Functions

```sql
-- Queue a thread for syncing
CREATE OR REPLACE FUNCTION queue_thread_sync(
  p_thread_id TEXT,
  p_grant_id TEXT,
  p_inbox_id UUID,
  p_config_id UUID
) RETURNS BIGINT AS $$
DECLARE
  v_msg_id BIGINT;
BEGIN
  SELECT pgmq.send(
    'thread_sync_jobs',
    jsonb_build_object(
      'thread_id', p_thread_id,
      'grant_id', p_grant_id,
      'inbox_id', p_inbox_id,
      'config_id', p_config_id
    )
  ) INTO v_msg_id;
  
  RETURN v_msg_id;
END;
$$ LANGUAGE plpgsql;

-- Update thread sync progress
CREATE OR REPLACE FUNCTION update_thread_sync_progress(
  p_config_id UUID,
  p_threads_queued INTEGER,
  p_threads_processed INTEGER,
  p_messages_synced INTEGER
) RETURNS VOID AS $$
BEGIN
  UPDATE support_inbox_configurations
  SET backfill_progress = jsonb_build_object(
    'threads_queued', p_threads_queued,
    'threads_processed', p_threads_processed,
    'messages_synced', p_messages_synced
  )
  WHERE id = p_config_id;
END;
$$ LANGUAGE plpgsql;
```

---

### Phase 2: Code Implementation

#### 2.1 BackfillProcessor (Orchestrator)

**File:** `src/backfill-processor.ts`

**Responsibilities:**
1. Read from `inbox_backfill_jobs` queue
2. Fetch thread IDs via paginated GET /threads requests
3. Queue each thread to `thread_sync_jobs`
4. Track inbox-level progress
5. Mark inbox backfill complete

**Key Logic:**
```typescript
async processBackfillJob(job: BackfillJob) {
  const { inbox_id, config_id, grant_id, start_date, end_date } = job.message;
  
  let threadsQueued = 0;
  let pageToken: string | undefined;
  
  // Fetch threads in pages
  do {
    const response = await this.nylas.threads.list({
      identifier: grant_id,
      queryParams: {
        limit: 50,
        latestMessageAfter: startTimestamp,
        latestMessageBefore: endTimestamp,
        ...(pageToken && { pageToken })
      }
    });
    
    // Queue each thread for processing
    for (const thread of response.data) {
      await this.queueThread(thread.id, grant_id, inbox_id, config_id);
      threadsQueued++;
    }
    
    // Update progress
    await this.updateProgress(config_id, threadsQueued, 0, 0);
    
    pageToken = response.nextCursor;
    
  } while (pageToken);
  
  // Mark orchestration complete
  await this.completeOrchestration(config_id, threadsQueued);
}
```

#### 2.2 ThreadSyncProcessor (Worker)

**File:** `src/thread-sync-processor.ts` (NEW)

**Responsibilities:**
1. Read from `thread_sync_jobs` queue
2. GET /threads/{thread_id} for thread details
3. GET /messages?thread_id={thread_id} for all messages
4. Sync thread + messages using NylasSync
5. Update thread-level progress

**Key Logic:**
```typescript
async processThreadJob(job: ThreadSyncJob) {
  const { thread_id, grant_id, inbox_id, config_id } = job.message;
  
  // Fetch thread details
  const threadResponse = await this.nylas.threads.find({
    identifier: grant_id,
    threadId: thread_id
  });
  
  // Fetch all messages in thread
  const messagesResponse = await this.nylas.messages.list({
    identifier: grant_id,
    queryParams: { threadId: thread_id }
  });
  
  // Sync using existing NylasSync logic
  await this.syncThreadWithMessages(
    threadResponse.data,
    messagesResponse.data,
    inbox_id
  );
  
  // Update progress
  await this.incrementThreadProgress(
    config_id,
    messagesResponse.data.length
  );
  
  // Acknowledge job
  await this.acknowledgeJob(job.msg_id);
}
```

#### 2.3 Update index.ts

**Run 3 processors in parallel:**
```typescript
webhookProcessor = new QueueProcessor();
backfillProcessor = new BackfillProcessor();
threadSyncProcessor = new ThreadSyncProcessor();

await Promise.all([
  webhookProcessor.start(),
  backfillProcessor.start(),
  threadSyncProcessor.start()
]);
```

---

### Phase 3: Progress Tracking

#### Inbox Level (BackfillProcessor)
```json
{
  "status": "in_progress",
  "progress": {
    "threads_queued": 500,
    "threads_processed": 150,
    "messages_synced": 1234,
    "current_page": 10
  }
}
```

#### Thread Level (ThreadSyncProcessor)
- Increment `threads_processed` after each thread
- Increment `messages_synced` by count of messages in thread

---

### Phase 4: Scalability Features

#### Parallel Thread Processing
```typescript
// Can run multiple ThreadSyncProcessor instances
const threadProcessor1 = new ThreadSyncProcessor();
const threadProcessor2 = new ThreadSyncProcessor();
const threadProcessor3 = new ThreadSyncProcessor();

await Promise.all([
  threadProcessor1.start(),
  threadProcessor2.start(),
  threadProcessor3.start()
]);
```

#### Rate Limiting
- Small delays between API calls (1000ms)
- Process threads sequentially within one processor
- Scale horizontally with multiple processors

---

## API Endpoints Used

### BackfillProcessor
1. `GET /v3/grants/{grant_id}/threads`
   - Query params: `limit`, `latestMessageAfter`, `latestMessageBefore`, `pageToken`
   - Returns: Thread IDs and metadata
   - Pagination: Use `next_cursor` → `pageToken`

### ThreadSyncProcessor
1. `GET /v3/grants/{grant_id}/threads/{thread_id}`
   - Returns: Complete thread details
   
2. `GET /v3/grants/{grant_id}/messages?thread_id={thread_id}`
   - Returns: All messages in thread
   - Usually single page (threads are manageable size)

---

## Error Handling & Retry Logic

### BackfillProcessor
- **Max retries:** 3
- **On failure:** Mark inbox backfill as failed, keep in queue for retry
- **On success:** Acknowledge job, update status to completed

### ThreadSyncProcessor
- **Max retries:** 5 (per thread)
- **On failure:** Keep in queue, increment read_ct
- **On success:** Acknowledge thread job, increment progress
- **Individual message failures:** Log warning, continue with other messages

---

## Testing Strategy

### Phase 1: Basic Testing
1. Create test inbox with 10 threads
2. Queue backfill job
3. Verify thread jobs created
4. Verify all messages synced
5. Check progress tracking

### Phase 2: Scale Testing
1. Test with 1,000 threads
2. Monitor queue depth
3. Verify webhook queue remains responsive
4. Check rate limiting behavior

### Phase 3: Failure Testing
1. Test network failures
2. Test API errors
3. Verify retry logic
4. Test graceful degradation

---

## Implementation Checklist

### Database
- [ ] Create `thread_sync_jobs` PGMQ queue
- [ ] Create `queue_thread_sync()` function
- [ ] Create `update_thread_sync_progress()` function
- [ ] Update `support_inbox_configurations.backfill_progress` schema

### BackfillProcessor
- [ ] Refactor to fetch threads (not messages)
- [ ] Implement thread queuing logic
- [ ] Fix pageToken conditional inclusion
- [ ] Update progress tracking for threads
- [ ] Test pagination handling

### ThreadSyncProcessor (NEW)
- [ ] Create new processor class
- [ ] Implement thread detail fetching
- [ ] Implement message fetching for thread
- [ ] Reuse NylasSync for database operations
- [ ] Add progress tracking
- [ ] Add error handling with retries

### Integration
- [ ] Update index.ts to run 3 processors
- [ ] Add graceful shutdown for all processors
- [ ] Add monitoring/logging
- [ ] Test parallel execution

### Testing
- [ ] Test with small inbox (10 threads)
- [ ] Test with medium inbox (100 threads)
- [ ] Test with large inbox (1000+ threads)
- [ ] Test webhook queue responsiveness
- [ ] Test failure recovery
- [ ] Monitor resource usage

---

## Monitoring & Observability

### Logs to Monitor
```
[Backfill] Queued 500 threads for processing
[ThreadSync] Processing thread abc123 (150/500)
[ThreadSync] Synced thread abc123: 8 messages
[Processor] Processing webhook notification (real-time)
```

### Metrics to Track
- Threads queued per minute
- Threads processed per minute
- Messages synced per minute
- Average messages per thread
- API call rate
- Queue depth for each queue
- Error rate per processor

---

## Performance Considerations

### API Rate Limits
- **Nylas rate limits:** Monitor `nylas-gmail-quota-usage` header
- **Batch size:** 50 threads per page, 10 threads processed at once
- **Delays:** 1000ms between thread API calls

### Queue Responsiveness
- **Webhook queue:** Processes between each thread (not blocked)
- **Thread queue depth:** Monitor to avoid OOM
- **Progress updates:** Every page of threads

### Database Performance
- **Batch inserts:** Messages inserted in batches per thread
- **Duplicate checking:** Efficient indexed queries
- **Progress updates:** Minimal DB writes

---

## Alternative: Three-Queue System (MAXIMUM SCALE)

If you need to handle millions of messages or have extreme rate limiting:

```
inbox_backfill_jobs
  → BackfillProcessor (queues threads)
    → thread_sync_jobs
      → ThreadSyncProcessor (queues messages)
        → message_sync_jobs
          → MessageSyncProcessor (syncs messages)
```

**When to use:**
- 1M+ messages per inbox
- Need per-message rate control
- Distributed processing across machines
- Complex per-message retry requirements

**Trade-offs:**
- Much higher complexity (4 processors)
- Loses thread context
- Higher DB overhead
- Slower for typical use cases

---

## Recommended Implementation Order

### Step 1: Fix Current Issues
- [x] Fix pageToken conditional inclusion
- [ ] Fix message ID extraction in webhook processor

### Step 2: Implement Two-Queue
- [ ] Create database functions
- [ ] Refactor BackfillProcessor
- [ ] Create ThreadSyncProcessor
- [ ] Update index.ts

### Step 3: Test & Monitor
- [ ] Test with real inboxes
- [ ] Monitor performance
- [ ] Tune batch sizes
- [ ] Add observability

### Step 4: Scale (if needed)
- [ ] Add multiple ThreadSyncProcessor instances
- [ ] Optimize API call patterns
- [ ] Consider three-queue if hitting limits

---

## Decision Matrix

| Criteria | Single Queue | Two-Queue ⭐ | Three-Queue |
|----------|--------------|-------------|-------------|
| Complexity | ⭐⭐⭐ Simple | ⭐⭐ Moderate | ⭐ Complex |
| Scalability | ⭐ Up to 10K | ⭐⭐ Up to 100K+ | ⭐⭐⭐ Millions |
| Webhook Responsiveness | ⭐ Blocked | ⭐⭐⭐ Good | ⭐⭐⭐ Excellent |
| Thread Context | ⭐⭐⭐ Maintained | ⭐⭐⭐ Maintained | ⭐ Lost |
| DB Overhead | ⭐⭐⭐ Low | ⭐⭐ Moderate | ⭐ High |
| Maintenance | ⭐⭐⭐ Easy | ⭐⭐ Moderate | ⭐ Difficult |
| **RECOMMENDED FOR** | Tiny inboxes | **Most use cases** | Extreme scale |

---

## Code Structure

```
src/
├── index.ts                    # Starts all 3 processors
├── queue-processor.ts          # Webhook notifications (existing)
├── backfill-processor.ts       # Inbox orchestration (refactored)
├── thread-sync-processor.ts    # Thread processing (NEW)
├── nylas-sync.ts              # Shared sync logic (existing)
├── notification-handler.ts     # Webhook handler (existing)
└── config.ts                   # Configuration (existing)

.nova/
└── two_queue.md               # This file
```

---

## Next Steps

1. **Review this plan** and decide: Two-queue or Three-queue?
2. **Implement database functions** for chosen architecture
3. **Refactor BackfillProcessor** to queue threads
4. **Create ThreadSyncProcessor** (or MessageSyncProcessor if three-queue)
5. **Test with real data**
6. **Monitor and tune**

---

## Questions to Answer

1. **Which architecture?** Two-queue (recommended) or three-queue?
2. **Parallelization level?** How many ThreadSyncProcessors to run?
3. **Batch sizes?** Threads per page, threads per batch?
4. **Progress granularity?** Update every thread, every 10 threads, every page?

---

*Document created: 2025-11-25*  
*Status: Architecture proposal - awaiting decision*
