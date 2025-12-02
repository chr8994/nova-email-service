import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { SpamDetector } from './spam-detector';

interface UnprocessedThread {
  thread_id: string;
  latest_message_id: string;
  message_count: number;
  inbox_id: string;
  tenant_id: string;
  latest_received_date: string;
  priority: number;
}

export class ExtractionQueueProcessor {
  private supabase: SupabaseClient;
  private spamDetector: SpamDetector;
  private isRunning = false;
  private readonly BATCH_SIZE: number;
  private readonly POLL_INTERVAL_MS: number;
  private totalQueued = 0;
  private totalSkipped = 0;
  private totalSpam = 0;
  
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
    
    this.spamDetector = new SpamDetector();
    this.BATCH_SIZE = config.extractionQueue.batchSize;
    this.POLL_INTERVAL_MS = config.extractionQueue.pollIntervalMs;
  }
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[ExtractionQueue] Already running');
      return;
    }
    
    if (!config.extractionQueue.enabled) {
      console.log('[ExtractionQueue] Disabled by configuration');
      return;
    }
    
    this.isRunning = true;
    console.log('[ExtractionQueue] Starting extraction queue processor');
    console.log(`[ExtractionQueue] Batch size: ${this.BATCH_SIZE}, Poll interval: ${this.POLL_INTERVAL_MS}ms`);
    console.log(`[ExtractionQueue] Spam detection: ${config.spamDetection.enabled ? 'enabled' : 'disabled'}`);
    console.log(`[ExtractionQueue] PGMQ: ${config.pgmq.enabled ? 'enabled' : 'disabled'}`);
    
    // Start continuous polling loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[ExtractionQueue] Stopping extraction queue processor');
    this.isRunning = false;
    console.log(`[ExtractionQueue] Stopped. Queued: ${this.totalQueued}, Skipped: ${this.totalSkipped}, Spam: ${this.totalSpam}`);
  }
  
  private async runWorker(): Promise<void> {
    console.log('[ExtractionQueue] Processor started. Listening for unprocessed threads...');
    
    // Continuously poll for unprocessed messages
    while (this.isRunning) {
      try {
        await this.processThreadBatch();
        
        // Wait before next poll
        await this.delay(this.POLL_INTERVAL_MS);
        
      } catch (error) {
        console.error('[ExtractionQueue] Worker error:', error);
        await this.delay(5000);
      }
    }
  }
  
  private async processThreadBatch(): Promise<void> {
    try {
      // Find threads needing extraction
      // This RPC already filters out spam/promotional threads
      const { data: unprocessedThreads, error } = await this.supabase.rpc('get_unprocessed_threads_for_extraction', {
        batch_limit: this.BATCH_SIZE
      });
      
      if (error) {
        console.error('[ExtractionQueue] Error querying unprocessed threads:', error);
        return;
      }
      
      if (!unprocessedThreads || unprocessedThreads.length === 0) {
        // No threads to process - this is normal
        return;
      }
      
      console.log(`[ExtractionQueue] Found ${unprocessedThreads.length} threads to check`);
      
      let queuedCount = 0;
      let skippedCount = 0;
      let spamCount = 0;
      
      // Process each thread
      for (const thread of unprocessedThreads as UnprocessedThread[]) {
        try {
          // Fetch thread subject upfront for all logging
          const threadSubject = await this.getThreadSubject(thread.thread_id);
          
          // Run spam detection if enabled and not already checked
          if (config.spamDetection.enabled) {
            const needsCheck = await this.spamDetector.needsCheck(thread.thread_id);
            if (needsCheck) {
              const spamResult = await this.spamDetector.checkThread(thread.thread_id);
              
              if (spamResult.is_spam || spamResult.is_promotional) {
                const type = spamResult.is_spam ? 'SPAM' : 'PROMOTIONAL';
                console.log(`[ExtractionQueue] Skipping ${type}: "${threadSubject}"`);
                console.log(`[ExtractionQueue]   Reason: ${spamResult.reasoning}`);
                spamCount++;
                continue;
              }
            }
          }
          
          // Double-check if already queued (race condition protection)
          const isQueued = await this.checkIfThreadQueued(thread.thread_id);
          if (isQueued) {
            console.log(`[ExtractionQueue] Already queued: "${threadSubject}"`);
            skippedCount++;
            continue;
          }
          
          // Queue the thread (to PGMQ if enabled, otherwise tracking table only)
          await this.queueThread(thread, threadSubject);
          queuedCount++;
          this.totalQueued++;
          
        } catch (error) {
          console.error(`[ExtractionQueue] Error processing thread ${thread.thread_id}:`, error);
          // Continue with other threads
        }
      }
      
      if (queuedCount > 0 || skippedCount > 0 || spamCount > 0) {
        console.log(`[ExtractionQueue] Batch complete: ${queuedCount} queued, ${skippedCount} skipped, ${spamCount} spam`);
      }
      
      this.totalSkipped += skippedCount;
      this.totalSpam += spamCount;
      
    } catch (error) {
      console.error('[ExtractionQueue] Error in processThreadBatch:', error);
    }
  }
  
  private async checkIfThreadQueued(threadId: string): Promise<boolean> {
    try {
      const { data, error } = await this.supabase
        .from('email_extraction_queue')
        .select('id')
        .eq('thread_id', threadId)
        .in('status', ['queued', 'processing', 'retrying'])
        .maybeSingle();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        console.error(`[ExtractionQueue] Error checking queue for thread ${threadId}:`, error);
        return false; // Assume not queued to avoid skipping
      }
      
      return !!data;
    } catch (error) {
      console.error('[ExtractionQueue] Error in checkIfThreadQueued:', error);
      return false;
    }
  }
  
  private async queueThread(thread: UnprocessedThread, threadSubject: string): Promise<void> {
    try {
      let pgmqMessageId: number | null = null;
      
      // Queue to PGMQ if enabled
      if (config.pgmq.enabled) {
        const { data, error } = await this.supabase.rpc('queue_thread_extraction', {
          p_thread_id: thread.thread_id,
          p_inbox_id: thread.inbox_id,
          p_tenant_id: thread.tenant_id,
          p_priority: thread.priority,
        });
        
        if (error) {
          console.error(`[ExtractionQueue] Error queueing to PGMQ:`, error);
          throw error;
        }
        
        pgmqMessageId = data;
      }
      
      // Also insert into tracking table for visibility
      const { error: trackingError } = await this.supabase
        .from('email_extraction_queue')
        .insert({
          thread_id: thread.thread_id,
          message_id: thread.latest_message_id,
          inbox_id: thread.inbox_id,
          tenant_id: thread.tenant_id,
          status: 'queued',
          priority: thread.priority,
          queued_at: new Date().toISOString(),
          pgmq_message_id: pgmqMessageId,
        });
      
      if (trackingError) {
        // Check if it's a duplicate key error
        if (trackingError.code === '23505') {
          console.log(`[ExtractionQueue] Thread ${thread.thread_id} already queued (duplicate key)`);
          return;
        }
        throw trackingError;
      }
      
      const queueType = config.pgmq.enabled ? 'PGMQ' : 'table';
      console.log(`[ExtractionQueue] Queued to ${queueType}: "${threadSubject}"`);
      console.log(`[ExtractionQueue]   Priority: ${thread.priority}, Messages: ${thread.message_count}`);
      
    } catch (error) {
      console.error(`[ExtractionQueue] Error queueing thread ${thread.thread_id}:`, error);
      throw error;
    }
  }
  
  private async getThreadSubject(threadId: string): Promise<string> {
    try {
      const { data, error } = await this.supabase
        .from('support_email_threads')
        .select('subject')
        .eq('id', threadId)
        .single();
      
      if (error || !data) {
        return 'Unknown Subject';
      }
      
      return data.subject || 'No Subject';
    } catch (error) {
      return 'Unknown Subject';
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
