import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';
import { NotificationHandler } from './notification-handler';

interface QueueMessage {
  msg_id: number;
  read_ct: number;
  enqueued_at: string;
  vt: string;
  message: {
    notification_id: string;
    webhook_id: string;
    inbox_id: string;
    notification_type: string;
    grant_id: string;
    payload: any;
    received_at: string;
  };
}

export class QueueProcessor {
  private supabase: SupabaseClient;
  private handler: NotificationHandler;
  private isRunning = false;
  
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
    
    this.handler = new NotificationHandler(this.supabase);
  }
  
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Processor] Already running');
      return;
    }
    
    this.isRunning = true;
    console.log(`[Processor] Starting queue consumer (TESTING MODE: ${config.testingMode ? 'ENABLED' : 'DISABLED'})`);
    
    if (config.testingMode) {
      console.log('[Processor] ⚠️  TESTING MODE - Messages will NOT be deleted from queue');
      console.log('[Processor] ⚠️  Messages will become visible again after visibility timeout');
    }
    
    // Start continuous polling loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[Processor] Stopping queue consumer');
    this.isRunning = false;
    console.log('[Processor] Stopped');
  }
  
  private async runWorker(): Promise<void> {
    console.log('[Processor] Queue consumer started. Listening for queue messages...');
    
    // Continuously poll the queue
    while (this.isRunning) {
      try {
        // Read from queue using direct PGMQ function
        const { data, error } = await this.supabase
          .schema('pgmq_public')
          .rpc('read', {
            queue_name: 'nylas_webhook_notifications',
            sleep_seconds: 60,
            n: config.queue.batchSize,
          });
        
        if (error) {
          console.error('[Processor] Error reading from queue:', error);
          await this.delay(2000);
          continue;
        }
        
        // If no messages, wait and repeat
        if (!data || data.length === 0) {
          await this.delay(config.queue.pollIntervalMs);
          continue;
        }
        
        console.log(`[Processor] Processing ${data.length} messages`);
        
        // Process each message
        for (const msg of data as QueueMessage[]) {
          await this.processMessage(msg);
        }
        
        await this.delay(1000);
        
      } catch (error) {
        console.error('[Processor] Worker error:', error);
        await this.delay(2000);
      }
    }
  }
  
  private async processMessage(msg: QueueMessage): Promise<void> {
    const startTime = Date.now();
    const { msg_id, read_ct, message: payload } = msg;
    
    // Check if message has been retried too many times
    if (read_ct > 3) {
      console.log(`[Processor] Message ${msg_id} has been retried ${read_ct} times. Marking as failed.`);
      
      // Update notification status to error
      const { error: updateError } = await this.supabase
        .from('support_webhook_notifications')
        .update({ 
          status: 'error',
          error_message: `Exceeded retry limit (${read_ct} attempts)`,
          processed_at: new Date().toISOString(),
        })
        .eq('id', payload.notification_id);
      
      if (updateError) {
        console.error('[Processor] Error updating notification status:', updateError);
      }
      
      // Remove the message from the queue
      const { error: deleteError } = await this.supabase
        .schema('pgmq_public')
        .rpc('delete', {
          queue_name: 'nylas_webhook_notifications',
          message_id: msg_id,
        });
      
      if (deleteError) {
        console.error('[Processor] Error deleting failed message from queue:', deleteError);
      } else {
        console.log(`[Processor] Removed failed message ${msg_id} from queue`);
      }
      
      return;
    }
    
    try {
      console.log(
        `[Processor] Processing notification ${payload.notification_id} (${payload.notification_type}) - attempt ${read_ct}`
      );
      
      // Update status to processing
      await this.supabase
        .from('support_webhook_notifications')
        .update({ status: 'processing' })
        .eq('id', payload.notification_id);
      
      // Process the notification
      await this.handler.handle(
        payload.notification_type,
        payload.grant_id,
        payload.inbox_id,
        payload.payload
      );
      
      const duration = Date.now() - startTime;
      
      // In testing mode, just log without acknowledging/deleting
      if (config.testingMode) {
        console.log('═══════════════════════════════════════════════');
        console.log('[TEST MODE] Message processed successfully');
        console.log(`[TEST MODE] Notification ID: ${payload.notification_id}`);
        console.log(`[TEST MODE] Type: ${payload.notification_type}`);
        console.log(`[TEST MODE] Duration: ${duration}ms`);
        console.log(`[TEST MODE] Full Payload:`, JSON.stringify(payload, null, 2));
        console.log('[TEST MODE] ⚠️  Message NOT deleted - will be visible again after visibility timeout');
        console.log('═══════════════════════════════════════════════\n');
      } else {
        // Production mode - update status and delete from queue
        const { error: updateError } = await this.supabase
          .from('support_webhook_notifications')
          .update({
            status: 'processed',
            processed_at: new Date().toISOString(),
            processing_duration_ms: duration,
          })
          .eq('id', payload.notification_id);
        
        if (updateError) {
          console.error('[Processor] Error updating notification status:', updateError);
        }
        
        // Remove message from queue
        const { error: deleteError } = await this.supabase
          .schema('pgmq_public')
          .rpc('delete', {
            queue_name: 'nylas_webhook_notifications',
            message_id: msg_id,
          });
        
        if (deleteError) {
          console.error('[Processor] Error deleting message from queue:', deleteError);
          return;
        }
        
        console.log(
          `[Processor] Successfully processed ${payload.notification_type} in ${duration}ms`
        );
      }
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(
        `[Processor] Error processing notification ${payload.notification_id}:`,
        error
      );
      
      // Update notification with error (but don't delete from queue - let it retry)
      await this.supabase
        .from('support_webhook_notifications')
        .update({
          status: 'error',
          error_message: errorMessage,
          processing_duration_ms: duration,
        })
        .eq('id', payload.notification_id);
      
      console.log(`[Processor] Marked notification as error after ${duration}ms (will retry)`);
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
