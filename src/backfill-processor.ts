import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Nylas from 'nylas';
import { config } from './config';
import { NylasSync } from './nylas-sync';

interface BackfillJob {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    inbox_id: string;
    config_id: string;
    grant_id: string;
    start_date: string;
    end_date: string;
  };
}

export class BackfillProcessor {
  private supabase: SupabaseClient;
  private nylas: Nylas;
  private nylasSync: NylasSync;
  private isRunning = false;
  private readonly BATCH_SIZE = 20;
  private readonly MAX_RETRIES = 3;
  private queuedThreadsCache: Set<string> = new Set();
  
  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
    
    this.nylas = new Nylas({
      apiKey: config.nylas.apiKey,
      apiUri: config.nylas.apiUri,
    });
    
    this.nylasSync = new NylasSync(this.supabase);
  }
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Backfill] Already running');
      return;
    }
    
    this.isRunning = true;
    console.log('[Backfill] Starting backfill processor');
    
    // Recover orphaned threads at startup
    await this.recoverOrphanedThreads();
    
    // Start continuous polling loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[Backfill] Stopping backfill processor');
    this.isRunning = false;
    console.log('[Backfill] Stopped');
  }
  
  private async runWorker(): Promise<void> {
    console.log('[Backfill] Backfill processor started. Listening for backfill jobs...');
    
    // Continuously poll the queue
    while (this.isRunning) {
      try {
        // Read from backfill queue
        const { data, error } = await this.supabase
          .schema('pgmq_public')
          .rpc('read', {
            queue_name: 'inbox_backfill_jobs',
            sleep_seconds: 30,
            n: 1, // Process one backfill job at a time
          });
        
        if (error) {
          console.error('[Backfill] Error reading from queue:', error);
          await this.delay(5000);
          continue;
        }
        
        // If no jobs, wait and repeat
        if (!data || data.length === 0) {
          await this.delay(10000); // Check every 10 seconds
          continue;
        }
        
        console.log('[Backfill] Found backfill job to process');
        
        // Process the backfill job
        const job = data[0] as BackfillJob;
        await this.processBackfillJob(job);
        
      } catch (error) {
        console.error('[Backfill] Worker error:', error);
        await this.delay(5000);
      }
    }
  }
  
  private async processBackfillJob(job: BackfillJob): Promise<void> {
    const startTime = Date.now();
    const { msg_id, read_ct, message: jobData } = job;
    let { inbox_id, config_id, grant_id, start_date, end_date } = jobData;
    
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
    
    // Check if job has been retried too many times
    if (read_ct > this.MAX_RETRIES) {
      console.log(`[Backfill] Job ${msg_id} exceeded retry limit (${read_ct} attempts)`);
      
      // Get current checkpoint before marking as failed
      const checkpoint = await this.getBackfillCheckpoint(config_id);
      
      if (checkpoint) {
        console.log(`[Backfill] Preserving checkpoint for retry: page ${checkpoint.current_page}, ${checkpoint.threads_queued} threads queued`);
      }
      
      // Mark as failed in database (checkpoint will be preserved by updateBackfillStatus)
      await this.updateBackfillStatus(config_id, 'failed', {
        error: `Exceeded retry limit (${read_ct} attempts)`,
        failed_at: new Date().toISOString()
      });
      
      // Delete from queue
      await this.deleteJob(msg_id);
      
      console.log(`[Backfill] Job deleted. Checkpoint preserved for manual retry.`);
      return;
    }
    
    try {
      console.log(`[Backfill] Starting thread-based backfill for inbox ${inbox_id}, config ${config_id}`);
      console.log(`[Backfill] Date range: ${start_date} to ${end_date}`);
      
      // Check for existing queued threads for this config and queue them first
      await this.checkForExistingQueuedThreads(config_id);
      
      // Clear the cache for this backfill job
      this.queuedThreadsCache.clear();
      
      // Update status to 'backfill' - orchestration phase
      await this.updateBackfillStatus(config_id, 'backfill', {
        started_at: new Date().toISOString()
      });
      
      // Convert dates to Unix timestamps
      const startTimestamp = Math.floor(new Date(start_date).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(end_date).getTime() / 1000);
      
      // Initialize sync stats entry (thread counts will be maintained by triggers)
      await this.initializeSyncStats(config_id, 0);
      
      // Check for existing checkpoint to resume from
      const checkpoint = await this.getBackfillCheckpoint(config_id);
      
      // Step 1: Fetch threads and queue each one
      let threadsQueued = checkpoint?.threads_queued || 0;
      let threadsSkipped = 0;
      let currentPage = checkpoint?.current_page || 0;
      let pageToken: string | undefined = checkpoint?.last_page_token;
      
      if (checkpoint && checkpoint.last_page_token) {
        console.log(`[Backfill] Resuming from checkpoint: page ${currentPage}, ${threadsQueued} threads already queued`);
      } else {
        console.log('[Backfill] Starting fresh backfill (no checkpoint found)');
      }
      
      console.log('[Backfill] Starting to fetch and queue threads...');
      
      do {
        console.log(`[Backfill] Fetching threads page ${currentPage + 1}`);
        
        // Fetch batch of threads
        const threadsResponse = await this.nylas.threads.list({
          identifier: grant_id,
          queryParams: {
            limit: 100,
            latestMessageAfter: startTimestamp,
            latestMessageBefore: endTimestamp,
            ...(pageToken && { page_token: pageToken }),
          },
        });
        
        if (!threadsResponse.data || threadsResponse.data.length === 0) {
          console.log('[Backfill] No more threads to process');
          break;
        }
        
        const threads = threadsResponse.data;
        console.log(`[Backfill] Fetched ${threads.length} threads`);
        
        // Queue each thread for processing (with deduplication)
        for (const thread of threads) {
          try {
            const wasQueued = await this.queueThreadWithDeduplication(
              thread.id, 
              grant_id, 
              inbox_id, 
              config_id
            );
            if (wasQueued) {
              console.log(`[Backfill] Queued thread ${thread.id} for processing`);
              threadsQueued++;
            } else {
              console.log(`[Backfill] Skipped thread ${thread.id} (already synced)`);
              threadsSkipped++;
            }
          } catch (error) {
            console.error(`[Backfill] Error queuing thread ${thread.id}:`, error);
            // Continue with other threads even if one fails
          }
        }
        
        // Update progress
        currentPage++;
        await this.updateOrchestrationProgress(config_id, threadsQueued, currentPage);
        console.log(`[Backfill] Queued ${threadsQueued} threads so far (page ${currentPage})`);
        
        // Get next page token
        pageToken = threadsResponse.nextCursor;
        console.log(`[Backfill] Next page token: ${pageToken ? pageToken : 'none (last page)'}`);
        
        // Save checkpoint after each successful page
        await this.saveBackfillCheckpoint(config_id, pageToken, threadsQueued, currentPage);
        
        // Small delay between batches to avoid rate limits
        await this.delay(100);
        
      } while (pageToken && this.isRunning);
      
      // Mark orchestration complete
      const duration = Date.now() - startTime;
      console.log(`[Backfill] Thread orchestration completed in ${Math.round(duration / 1000)}s`);
      console.log(`[Backfill] Total threads queued: ${threadsQueued}`);
      console.log(`[Backfill] Threads skipped (already synced): ${threadsSkipped}`);
      console.log(`[Backfill] Total threads processed: ${threadsQueued + threadsSkipped}`);
      
      if (threadsQueued === 0) {
        console.log('[Backfill] No threads found to backfill');
        await this.completeBackfill(config_id, msg_id);
        return;
      }
      
      // Transition to 'thread_sync' status - opens the gate for thread processing!
      await this.supabase.rpc('transition_to_thread_sync', {
        p_config_id: config_id,
        p_threads_queued: threadsQueued
      });
      
      console.log(`[Backfill] Transitioned to thread_sync phase with ${threadsQueued} threads already in PGMQ`);
      console.log(`[Backfill] Thread-sync-processor can now process threads for config ${config_id}`);
      
      // Clear the checkpoint now that backfill is complete
      await this.clearBackfillCheckpoint(config_id);
      
      // Delete this orchestration job from the queue
      await this.deleteJob(msg_id);
      console.log('[Backfill] Orchestration job acknowledged. Thread processors will now sync messages.');
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(`[Backfill] Error processing backfill job:`, error);
      
      // Update status to error (but don't delete from queue - let it retry)
      await this.updateBackfillStatus(config_id, 'failed', {
        error: errorMessage,
        failed_at: new Date().toISOString()
      });
      
      console.log(`[Backfill] Marked backfill as failed after ${Math.round(duration / 1000)}s (will retry)`);
    }
  }
  
  private async queueThreadWithDeduplication(
    threadId: string,
    grantId: string,
    inboxId: string,
    configId: string
  ): Promise<boolean> {
    // Check in-memory cache first (fast)
    if (this.queuedThreadsCache.has(threadId)) {
      console.log(`[Backfill] Thread ${threadId} already queued in this session, skipping`);
      return false;
    }
    
    // Check if thread already exists in database
    const threadExists = await this.checkThreadExists(threadId);
    if (threadExists) {
      console.log(`[Backfill] Thread ${threadId} already exists in database, skipping`);
      // Add to cache to avoid checking again
      this.queuedThreadsCache.add(threadId);
      return false;
    }
    
    // Thread is new - insert to queued_threads table
    await this.insertQueuedThread(configId, inboxId, threadId, grantId);
    
    // IMMEDIATELY queue to PGMQ (don't wait for bulk)
    await this.queueThreadToPGMQ(threadId, grantId, inboxId, configId);
    
    // Add to cache
    this.queuedThreadsCache.add(threadId);
    return true;
  }
  
  private async checkThreadExists(threadId: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase
        .from('support_email_threads')
        .select('id')
        .eq('nylas_thread_id', threadId)
        .maybeSingle();
      
      if (error) {
        console.error(`[Backfill] Error checking if thread ${threadId} exists:`, error);
        // On error, assume it doesn't exist to avoid skipping threads
        return false;
      }
      
      return !!data;
    } catch (error) {
      console.error(`[Backfill] Error checking thread existence:`, error);
      return false;
    }
  }
  
  private async queueThread(
    threadId: string,
    grantId: string,
    inboxId: string,
    configId: string
  ): Promise<void> {
    try {
      await this.supabase.rpc('queue_thread_sync', {
        p_thread_id: threadId,
        p_grant_id: grantId,
        p_inbox_id: inboxId,
        p_config_id: configId,
      });
    } catch (error) {
      console.error(`[Backfill] Error queuing thread ${threadId}:`, error);
      throw error;
    }
  }
  
  private async updateOrchestrationProgress(
    configId: string,
    threadsQueued: number,
    currentPage: number
  ): Promise<void> {
    try {
      await this.supabase.rpc('update_backfill_orchestration_progress', {
        p_config_id: configId,
        p_threads_queued: threadsQueued,
        p_current_page: currentPage,
      });
    } catch (error) {
      console.error('[Backfill] Error updating orchestration progress:', error);
      // Don't throw - progress update failure shouldn't stop backfill
    }
  }
  
  private async getMessageCount(grantId: string, startDate: string, endDate: string): Promise<number> {
    try {
      // Fetch first page to get total count
      const response = await this.nylas.messages.list({
        identifier: grantId,
        queryParams: {
          limit: 1,
          receivedAfter: Math.floor(new Date(startDate).getTime() / 1000),
          receivedBefore: Math.floor(new Date(endDate).getTime() / 1000),
        },
      });
      
      // Nylas doesn't return total count directly, so we need to estimate
      // by fetching all pages or using a reasonable estimate
      // For now, we'll make multiple requests to count
      let totalCount = 0;
      let pageToken: string | undefined;
      
      // Fetch first batch to start counting
      let countResponse = await this.nylas.messages.list({
        identifier: grantId,
        queryParams: {
          limit: 50,
          receivedAfter: Math.floor(new Date(startDate).getTime() / 1000),
          receivedBefore: Math.floor(new Date(endDate).getTime() / 1000),
        },
      });
      
      // Count initial batch
      totalCount += countResponse.data?.length || 0;
      pageToken = countResponse.nextCursor;
      
      // Count remaining pages (limit to prevent excessive API calls)
      let pageCount = 1;
      const maxCountPages = 20; // Only count first ~1000 messages for estimate
      
      while (pageToken && pageCount < maxCountPages) {
        countResponse = await this.nylas.messages.list({
          identifier: grantId,
          queryParams: {
            limit: 50,
            receivedAfter: Math.floor(new Date(startDate).getTime() / 1000),
            receivedBefore: Math.floor(new Date(endDate).getTime() / 1000),
            pageToken: pageToken,
          },
        });
        
        totalCount += countResponse.data?.length || 0;
        pageToken = countResponse.nextCursor;
        pageCount++;
        
        // Small delay to avoid rate limits
        await this.delay(500);
      }
      
      // If there are more pages, estimate total
      if (pageToken) {
        // Rough estimate: if we've seen 1000 messages and there are more,
        // estimate based on average messages per day
        const daysInRange = Math.ceil(
          (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
        );
        totalCount = Math.ceil(totalCount * 1.5); // Conservative estimate
        console.log(`[Backfill] Estimated total count: ${totalCount} (based on ${pageCount} pages)`);
      }
      
      return totalCount;
      
    } catch (error) {
      console.error('[Backfill] Error getting message count:', error);
      // Return 0 if count fails - backfill will still proceed
      return 0;
    }
  }
  
  
  private async updateBackfillStatus(
    configId: string,
    status: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    try {
      const updates: Record<string, any> = {
        backfill_status: status,
      };
      
      if (metadata?.started_at) {
        updates.backfill_started_at = metadata.started_at;
      }
      
      if (metadata?.completed_at) {
        updates.backfill_completed_at = metadata.completed_at;
      }
      
      if (metadata?.error) {
        // Get current progress to preserve checkpoint data
        const { data: currentConfig } = await this.supabase
          .from('support_inbox_configurations')
          .select('backfill_progress')
          .eq('id', configId)
          .single();
        
        // Merge error with existing progress to preserve checkpoint
        updates.backfill_progress = {
          ...(currentConfig?.backfill_progress || {}),
          error: metadata.error,
          failed_at: metadata.failed_at || new Date().toISOString(),
        };
      }
      
      await this.supabase
        .from('support_inbox_configurations')
        .update(updates)
        .eq('id', configId);
        
    } catch (error) {
      console.error('[Backfill] Error updating backfill status:', error);
    }
  }
  
  private async completeBackfill(configId: string, msgId: number): Promise<void> {
    try {
      // Update status to completed
      await this.updateBackfillStatus(configId, 'completed', {
        completed_at: new Date().toISOString()
      });
      
      // Call acknowledge function to mark job complete
      await this.supabase.rpc('acknowledge_backfill_job', {
        p_msg_id: msgId,
        p_config_id: configId,
      });
      
      console.log('[Backfill] Backfill job completed and acknowledged');
      
    } catch (error) {
      console.error('[Backfill] Error completing backfill:', error);
      // Try to delete from queue anyway
      await this.deleteJob(msgId);
    }
  }
  
  private async deleteJob(msgId: number): Promise<void> {
    try {
      const { error } = await this.supabase
        .schema('pgmq_public')
        .rpc('delete', {
          queue_name: 'inbox_backfill_jobs',
          message_id: msgId,
        });
      
      if (error) {
        console.error('[Backfill] Error deleting job from queue:', error);
      } else {
        console.log(`[Backfill] Deleted job ${msgId} from queue`);
      }
    } catch (error) {
      console.error('[Backfill] Error deleting job:', error);
    }
  }
  
  private async initializeSyncStats(configId: string, threadsTotal: number): Promise<void> {
    try {
      // Initialize or ensure sync stats entry exists
      // Threads_queued will be automatically maintained by triggers
      await this.supabase.rpc('initialize_sync_stats', {
        p_config_id: configId,
        p_threads_total: threadsTotal,
      });
    } catch (error) {
      console.error('[Backfill] Error initializing sync stats:', error);
      // Don't throw - stats initialization failure shouldn't stop backfill
    }
  }
  
  private async getBackfillCheckpoint(configId: string): Promise<{
    last_page_token?: string;
    threads_queued?: number;
    current_page?: number;
  } | null> {
    try {
      const { data, error } = await this.supabase
        .from('support_inbox_configurations')
        .select('backfill_progress')
        .eq('id', configId)
        .single();
      
      if (error || !data?.backfill_progress) {
        return null;
      }
      
      const progress = data.backfill_progress as any;
      return {
        last_page_token: progress.last_page_token,
        threads_queued: progress.threads_queued || 0,
        current_page: progress.current_page || 0,
      };
    } catch (error) {
      console.error('[Backfill] Error getting checkpoint:', error);
      return null;
    }
  }
  
  private async saveBackfillCheckpoint(
    configId: string,
    pageToken: string | undefined,
    threadsQueued: number,
    currentPage: number
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('support_inbox_configurations')
        .update({
          backfill_progress: {
            last_page_token: pageToken,
            threads_queued: threadsQueued,
            current_page: currentPage,
            last_checkpoint_at: new Date().toISOString(),
          },
        })
        .eq('id', configId);
      
      if (error) {
        console.error('[Backfill] Error saving checkpoint:', error);
      }
    } catch (error) {
      console.error('[Backfill] Error saving checkpoint:', error);
    }
  }
  
  private async clearBackfillCheckpoint(configId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('support_inbox_configurations')
        .update({
          backfill_progress: {
            threads_queued: 0,
            current_page: 0,
            // Keep other progress info, just clear checkpoint fields
          },
        })
        .eq('id', configId);
      
      if (error) {
        console.error('[Backfill] Error clearing checkpoint:', error);
      }
    } catch (error) {
      console.error('[Backfill] Error clearing checkpoint:', error);
    }
  }
  
  private async insertQueuedThread(
    configId: string,
    inboxId: string,
    threadId: string,
    grantId: string
  ): Promise<void> {
    try {
      // Use idempotent insert function to avoid duplicate key errors
      const { error } = await this.supabase.rpc('insert_queued_thread_idempotent', {
        p_config_id: configId,
        p_inbox_id: inboxId,
        p_thread_id: threadId,
        p_grant_id: grantId,
      });
      
      if (error) {
        console.error(`[Backfill] Error inserting queued_thread for ${threadId}:`, error);
      }
    } catch (error) {
      console.error('[Backfill] Error inserting queued thread:', error);
    }
  }
  
  private async recoverOrphanedThreads(): Promise<void> {
    console.log('[Backfill] Checking for orphaned threads...');
    
    try {
      let totalProcessed = 0;
      let batchNumber = 0;
      const BATCH_SIZE = 1000;
      
      // Keep processing batches until no more orphaned threads are found
      while (this.isRunning) {
        batchNumber++;
        
        // Query for threads that are queued but not in PGMQ (limit to batch size)
        const { data: orphanedThreads, error } = await this.supabase
          .from('queued_threads')
          .select('config_id, thread_id, grant_id, inbox_id')
          .eq('status', 'queued')
          .is('pgmq_queued_at', null)
          .limit(BATCH_SIZE);
        
        if (error) {
          console.error('[Backfill] Error querying orphaned threads:', error);
          return;
        }
        
        if (!orphanedThreads || orphanedThreads.length === 0) {
          if (batchNumber === 1) {
            console.log('[Backfill] No orphaned threads found');
          } else {
            console.log(`[Backfill] Orphaned thread recovery complete. Total processed: ${totalProcessed} threads across ${batchNumber - 1} batches`);
          }
          return;
        }
        
        console.log(`[Backfill] Batch ${batchNumber}: Found ${orphanedThreads.length} orphaned threads`);
        
        // Group by config_id
        const byConfig = orphanedThreads.reduce((acc, thread) => {
          if (!acc[thread.config_id]) acc[thread.config_id] = [];
          acc[thread.config_id].push(thread);
          return acc;
        }, {} as Record<string, typeof orphanedThreads>);
        
        // Queue each config's threads (in parallel batches for speed)
        let batchSuccessCount = 0;
        const PARALLEL_BATCH_SIZE = 20; // Process 20 threads at a time
        
        for (const [configId, threads] of Object.entries(byConfig)) {
          console.log(`[Backfill] Batch ${batchNumber}: Queueing ${threads.length} orphaned threads for config ${configId}`);
          
          let successCount = 0;
          
          // Process threads in parallel chunks
          for (let i = 0; i < threads.length; i += PARALLEL_BATCH_SIZE) {
            const chunk = threads.slice(i, i + PARALLEL_BATCH_SIZE);
            
            // Queue chunk in parallel
            const results = await Promise.allSettled(
              chunk.map(thread => 
                this.queueThreadToPGMQ(
                  thread.thread_id,
                  thread.grant_id,
                  thread.inbox_id,
                  thread.config_id
                )
              )
            );
            
            // Count successes
            const chunkSuccesses = results.filter(r => r.status === 'fulfilled').length;
            successCount += chunkSuccesses;
            batchSuccessCount += chunkSuccesses;
            
            // Log progress every chunk
            if ((i + PARALLEL_BATCH_SIZE) % 100 === 0 || i + PARALLEL_BATCH_SIZE >= threads.length) {
              console.log(`[Backfill] Batch ${batchNumber}: Progress ${Math.min(i + PARALLEL_BATCH_SIZE, threads.length)}/${threads.length} threads for config ${configId}`);
            }
          }
          
          console.log(`[Backfill] Batch ${batchNumber}: Queued ${successCount}/${threads.length} threads for config ${configId}`);
        }
        
        totalProcessed += batchSuccessCount;
        console.log(`[Backfill] Batch ${batchNumber} complete. ${batchSuccessCount} threads queued. Running total: ${totalProcessed}`);
        
        // If we processed fewer than the batch size, we're done
        if (orphanedThreads.length < BATCH_SIZE) {
          console.log(`[Backfill] Orphaned thread recovery complete. Total processed: ${totalProcessed} threads across ${batchNumber} batches`);
          return;
        }
        
        // Small delay between batches to avoid overwhelming the system
        await this.delay(1000);
      }
    } catch (error) {
      console.error('[Backfill] Error during orphaned thread recovery:', error);
      // Don't throw - recovery failure shouldn't prevent startup
    }
  }
  
  private async checkForExistingQueuedThreads(configId: string): Promise<void> {
    try {
      const { data: existingThreads, error } = await this.supabase
        .from('queued_threads')
        .select('thread_id, grant_id, inbox_id, config_id')
        .eq('config_id', configId)
        .eq('status', 'queued')
        .is('pgmq_queued_at', null);
      
      if (error) {
        console.error('[Backfill] Error checking for existing queued threads:', error);
        return;
      }
      
      if (existingThreads && existingThreads.length > 0) {
        console.log(`[Backfill] Found ${existingThreads.length} existing queued threads for config ${configId}`);
        console.log('[Backfill] Queueing them to PGMQ before starting new backfill...');
        
        let successCount = 0;
        for (const thread of existingThreads) {
          try {
            await this.queueThreadToPGMQ(
              thread.thread_id,
              thread.grant_id,
              thread.inbox_id,
              thread.config_id
            );
            successCount++;
          } catch (error) {
            console.error(`[Backfill] Error queueing existing thread ${thread.thread_id}:`, error);
            // Continue with other threads
          }
        }
        
        console.log(`[Backfill] Queued ${successCount}/${existingThreads.length} existing threads to PGMQ`);
      }
    } catch (error) {
      console.error('[Backfill] Error checking existing queued threads:', error);
      // Don't throw - this shouldn't prevent backfill from proceeding
    }
  }
  
  private async queueThreadToPGMQ(
    threadId: string,
    grantId: string,
    inboxId: string,
    configId: string
  ): Promise<void> {
    try {
      // Queue to PGMQ using existing queueThread method
      await this.queueThread(threadId, grantId, inboxId, configId);
      
      // Update pgmq_queued_at timestamp
      const { error } = await this.supabase
        .from('queued_threads')
        .update({ pgmq_queued_at: new Date().toISOString() })
        .eq('config_id', configId)
        .eq('nylas_thread_id', threadId);
      
      if (error) {
        console.error(`[Backfill] Error updating pgmq_queued_at for thread ${threadId}:`, error);
        // Don't throw - the thread is in PGMQ which is what matters
      }
    } catch (error) {
      console.error(`[Backfill] Error queueing thread ${threadId} to PGMQ:`, error);
      throw error;
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
