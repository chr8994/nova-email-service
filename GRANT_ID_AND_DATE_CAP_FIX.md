# Grant ID and Date Range Fixes

## Overview
Fixed two critical issues with the email backfill system:
1. **Missing grant_id error** causing thread sync failures
2. **No date range limit** allowing multi-year backfills

## Problem 1: Missing Grant ID

### Root Cause
The `grant_id` field in the `queued_threads` table was nullable and all existing records had NULL values. When the thread-sync-processor tried to process these threads, it passed `null` to the Nylas SDK, causing the error:
```
Error: Missing replacement for identifier
```

### Solutions Implemented

#### 1. Thread Sync Processor Fallback (`src/thread-sync-processor.ts`)
Added fallback logic to fetch `grant_id` from `support_inboxes` when missing:

```typescript
// CRITICAL FIX: If grant_id is missing, fetch it from support_inboxes
if (!grant_id || grant_id === '') {
  console.log(`[ThreadSync] grant_id missing for thread ${thread_id}, fetching from support_inboxes...`);
  const { data, error } = await this.supabase
    .from('support_inboxes')
    .select('nylas_grant_id')
    .eq('id', inbox_id)
    .single();
  
  if (error) {
    console.error(`[ThreadSync] Error fetching grant_id for inbox ${inbox_id}:`, error);
    throw new Error(`Failed to fetch grant_id: ${error.message}`);
  }
  
  if (!data?.nylas_grant_id) {
    throw new Error(`No grant_id found for inbox ${inbox_id}`);
  }
  
  grant_id = data.nylas_grant_id;
  console.log(`[ThreadSync] Fetched grant_id: ${grant_id}`);
}
```

**Benefits:**
- Handles both existing NULL grant_ids and future missing values
- Provides clear logging for debugging
- Fails gracefully with helpful error messages

#### 2. Database Function Fix (`migrations/004_fix_grant_id_preservation.sql`)
Updated `insert_queued_thread_idempotent` function to preserve grant_id on conflict:

```sql
ON CONFLICT (config_id, nylas_thread_id) 
DO UPDATE SET 
  queued_at = EXCLUDED.queued_at,
  status = 'queued',
  grant_id = EXCLUDED.grant_id;  -- CRITICAL FIX: Preserve grant_id
```

**Benefits:**
- Prevents grant_id from being lost when threads are re-queued
- Ensures future threads always have grant_id populated

## Problem 2: Unlimited Date Ranges

### Root Cause
The backfill processor accepted any date range, allowing multi-year backfills that could:
- Overwhelm the system with excessive API calls
- Create performance issues
- Process more data than necessary

### Solution Implemented

#### Date Range Validation (`src/backfill-processor.ts`)
Added automatic 1-year cap at the start of `processBackfillJob`:

```typescript
// Enforce max 1 year date range
const startDate = new Date(start_date);
const endDate = new Date(end_date);
const daysDifference = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

if (daysDifference > 365) {
  const adjustedStartDate = new Date(endDate);
  adjustedStartDate.setDate(adjustedStartDate.getDate() - 365);
  
  console.log(`[Backfill] ⚠️  Date range exceeds 1 year (${daysDifference} days)`);
  console.log(`[Backfill] Original range: ${start_date} to ${end_date}`);
  console.log(`[Backfill] Adjusted to 1 year: ${adjustedStartDate.toISOString()} to ${end_date}`);
  
  // Update the start_date used for processing
  start_date = adjustedStartDate.toISOString();
} else {
  console.log(`[Backfill] Date range: ${daysDifference} days (within 1 year limit)`);
}
```

**Benefits:**
- Automatically caps any date range to exactly 1 year
- Processes the most recent year of data (works backwards from end_date)
- Applies to both existing queued jobs and future jobs
- Provides clear logging when adjustments are made
- No need to modify or clear existing queue

## Testing

### For Grant ID Fix
1. Restart the service to pick up the thread-sync-processor changes
2. Existing queued threads with NULL grant_ids will automatically fetch from support_inboxes
3. Monitor logs for messages like:
   - `[ThreadSync] grant_id missing for thread X, fetching from support_inboxes...`
   - `[ThreadSync] Fetched grant_id: XXX`

### For Date Range Fix
1. Restart the service to pick up the backfill-processor changes
2. Any backfill job with > 365 day range will be automatically capped
3. Monitor logs for messages like:
   - `[Backfill] ⚠️  Date range exceeds 1 year (XXX days)`
   - `[Backfill] Adjusted to 1 year: ...`

## Migration Status

- ✅ `src/thread-sync-processor.ts` - Updated with grant_id fallback
- ✅ `src/backfill-processor.ts` - Updated with 1-year date cap
- ⏳ `migrations/004_fix_grant_id_preservation.sql` - Created (needs manual application)

## Next Steps

1. Apply the database migration when ready:
   ```sql
   -- Run migrations/004_fix_grant_id_preservation.sql
   ```

2. Restart the service to apply code changes

3. Monitor logs for successful processing of previously failing threads

## Files Modified

- `src/thread-sync-processor.ts` - Added grant_id fallback logic
- `src/backfill-processor.ts` - Added 1-year date range validation
- `migrations/004_fix_grant_id_preservation.sql` - Database function fix
