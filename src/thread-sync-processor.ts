import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Nylas from 'nylas';
import { config } from './config';
import { NylasSync } from './nylas-sync';

interface ThreadSyncJob {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    thread_id: string;
    grant_id: string;
    inbox_id: string;
    config_id: string;
  };
}

export class ThreadSyncProcessor {
  private supabase: SupabaseClient;
  private nylas: Nylas;
  private nylasSync: NylasSync;
  private isRunning = false;
  private readonly MAX_RETRIES = 5;
  
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
      console.log('[ThreadSync] Already running');
      return;
    }
    
    this.isRunning = true;
    console.log('[ThreadSync] Starting thread sync processor');
    
    // Start continuous polling loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[ThreadSync] Stopping thread sync processor');
    this.isRunning = false;
    console.log('[ThreadSync] Stopped');
  }
  
  private async runWorker(): Promise<void> {
    console.log('[ThreadSync] Thread sync processor started. Listening for thread jobs...');
    
    // Continuously poll the queue
    while (this.isRunning) {
      try {
        // Read from thread sync queue
        const { data, error } = await this.supabase
          .schema('pgmq_public')
          .rpc('read', {
            queue_name: 'thread_sync_jobs',
            sleep_seconds: 10,
            n: 1, // Process one thread at a time
          });
        
        if (error) {
          console.error('[ThreadSync] Error reading from queue:', error);
          await this.delay(5000);
          continue;
        }
        
        // If no jobs, wait and repeat
        if (!data || data.length === 0) {
          await this.delay(5000); // Check every 5 seconds
          continue;
        }
        
        // Process the thread job
        const job = data[0] as ThreadSyncJob;
        await this.processThreadJob(job);
        
        // Add delay before picking up next thread
        console.log(`[ThreadSync] Waiting ${config.processing.threadDelayMs}ms before next thread...`);
        await this.delay(config.processing.threadDelayMs);
        
      } catch (error) {
        console.error('[ThreadSync] Worker error:', error);
        await this.delay(5000);
      }
    }
  }
  
  private async processThreadJob(job: ThreadSyncJob): Promise<void> {
    const startTime = Date.now();
    const { msg_id, read_ct, message: jobData } = job;
    let { thread_id, grant_id, inbox_id, config_id } = jobData;
    
    // Check if job has been retried too many times
    if (read_ct > this.MAX_RETRIES) {
      console.log(`[ThreadSync] Job ${msg_id} exceeded retry limit (${read_ct} attempts)`);
      
      // Delete from queue (give up on this thread)
      await this.deleteJob(msg_id);
      return;
    }
    
    try {
      console.log(`[ThreadSync] Processing thread ${thread_id} (attempt ${read_ct + 1}/${this.MAX_RETRIES})`);
      
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
      
      // Mark thread as processing in queued_threads (trigger will update stats!)
      await this.markThreadProcessing(config_id, thread_id);
      
      // Step 1: Fetch thread details
      const threadResponse = await this.nylas.threads.find({
        identifier: grant_id,
        threadId: thread_id,
      });
      
      if (!threadResponse.data) {
        console.warn(`[ThreadSync] Thread ${thread_id} not found, skipping`);
        await this.completeThread(msg_id, config_id, thread_id, 0, true);
        return;
      }
      
      const thread = threadResponse.data;
      console.log(`[ThreadSync] Fetched thread details: ${thread.subject || 'No subject'}`);
      console.log(`[ThreadSync] Waiting ${config.processing.apiDelayMs}ms before fetching messages...`);
      await this.delay(config.processing.apiDelayMs);
      
      // Step 2: Fetch all messages in thread
      const messagesResponse = await this.nylas.messages.list({
        identifier: grant_id,
        queryParams: {
          threadId: thread_id,
          limit: 100, // Most threads won't have more than 100 messages
        },
      });
      
      const messages = messagesResponse.data || [];
      console.log(`[ThreadSync] Fetched ${messages.length} messages for thread ${thread_id}`);
      
      if (messages.length === 0) {
        console.warn(`[ThreadSync] No messages found for thread ${thread_id}, skipping`);
        await this.completeThread(msg_id, config_id, thread_id, 0, true);
        return;
      }
      
      // Step 3: Sync thread and all messages using existing NylasSync
      let syncedCount = 0;
      console.log(`[ThreadSync] Starting to sync ${messages.length} messages...`);
      
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        try {
          console.log(`[ThreadSync] Syncing message ${i + 1}/${messages.length} (ID: ${message.id})`);
          await this.nylasSync.syncMessage(grant_id, inbox_id, message.id);
          syncedCount++;
          
          // Add delay to prevent rate limiting
          if (i < messages.length - 1) {
            console.log(`[ThreadSync] Waiting ${config.processing.apiDelayMs}ms before next message...`);
            await this.delay(config.processing.apiDelayMs);
          }
        } catch (error) {
          console.error(`[ThreadSync] Error syncing message ${message.id}:`, error);
          // Continue with other messages even if one fails
        }
      }
      
      const duration = Date.now() - startTime;
      console.log(`[ThreadSync] Thread ${thread_id} synced: ${syncedCount}/${messages.length} messages in ${Math.round(duration / 1000)}s`);
      
      // Step 4: Mark thread as completed and delete from queue (trigger handles stats!)
      await this.completeThread(msg_id, config_id, thread_id, syncedCount, true);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(`[ThreadSync] Error processing thread ${thread_id}:`, error);
      
      // Mark as failed if we've exceeded retries, otherwise let it retry
      if (read_ct >= this.MAX_RETRIES) {
        console.log(`[ThreadSync] Thread ${thread_id} exceeded retries, marking as failed`);
        await this.completeThread(msg_id, config_id, thread_id, 0, false);
      } else {
        console.log(`[ThreadSync] Thread job will retry (attempt ${read_ct + 1}/${this.MAX_RETRIES}) after ${Math.round(duration / 1000)}s`);
        // Don't delete - let it retry
      }
    }
  }
  
  private async completeThread(
    msgId: number,
    configId: string,
    threadId: string,
    messagesSynced: number,
    success: boolean
  ): Promise<void> {
    try {
      // Update queued_threads status - trigger will auto-update stats!
      const { error } = await this.supabase
        .from('queued_threads')
        .update({
          status: success ? 'completed' : 'failed',
          messages_synced: messagesSynced,
          processed_at: new Date().toISOString()
        })
        .eq('config_id', configId)
        .eq('thread_id', threadId)
        .eq('status', 'processing');
      
      if (error) {
        console.error(`[ThreadSync] Error updating thread status for ${threadId}:`, error);
      }
      
      // Delete from PGMQ queue
      await this.deleteJob(msgId);
      
      console.log(`[ThreadSync] Thread ${threadId} marked as ${success ? 'completed' : 'failed'}, synced ${messagesSynced} messages`);
      
    } catch (error) {
      console.error('[ThreadSync] Error completing thread:', error);
      // Try to delete from queue anyway
      await this.deleteJob(msgId);
    }
  }
  
  private async deleteJob(msgId: number): Promise<void> {
    try {
      const { error } = await this.supabase
        .schema('pgmq_public')
        .rpc('delete', {
          queue_name: 'thread_sync_jobs',
          message_id: msgId,
        });
      
      if (error) {
        console.error('[ThreadSync] Error deleting job from queue:', error);
      } else {
        console.log(`[ThreadSync] Deleted job ${msgId} from queue`);
      }
    } catch (error) {
      console.error('[ThreadSync] Error deleting job:', error);
    }
  }
  
  private async markThreadProcessing(configId: string, threadId: string): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('queued_threads')
        .update({
          status: 'processing',
          started_at: new Date().toISOString()
        })
        .eq('config_id', configId)
        .eq('thread_id', threadId)
        .eq('status', 'queued');
      
      if (error) {
        console.error(`[ThreadSync] Error marking thread ${threadId} as processing:`, error);
      }
    } catch (error) {
      console.error('[ThreadSync] Error marking thread as processing:', error);
      // Don't throw - stats update failure shouldn't stop processing
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
