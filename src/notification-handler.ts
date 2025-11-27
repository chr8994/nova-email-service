import { SupabaseClient } from '@supabase/supabase-js';
import { NylasSync } from './nylas-sync';

export class NotificationHandler {
  private nylasSync: NylasSync;
  
  constructor(private supabase: SupabaseClient) {
    this.nylasSync = new NylasSync(supabase);
  }
  
  async handle(
    notificationType: string,
    grantId: string,
    inboxId: string,
    payload: any
  ): Promise<void> {
    console.log(`[Handler] Processing ${notificationType}`);
    
    try {
      if (
        notificationType.startsWith('message.created') ||
        notificationType.startsWith('message.updated')
      ) {
        // Log payload structure for debugging
        console.log('[Handler] Webhook payload structure:', JSON.stringify(payload, null, 2));
        
        // Extract message_id from webhook payload - try multiple possible locations
        const messageId = 
          payload.data?.object?.id ||  // Standard Nylas webhook format: payload.data.object.id
          payload.data?.id ||           // Alternative format: payload.data.id
          payload.object?.id ||         // Alternative format: payload.object.id
          payload.id;                   // Direct format: payload.id
        
        if (!messageId) {
          console.error('[Handler] Could not find message ID in any expected location');
          console.error('[Handler] Payload keys:', Object.keys(payload));
          console.error('[Handler] payload.data keys:', payload.data ? Object.keys(payload.data) : 'N/A');
          throw new Error('Message ID missing from webhook payload');
        }
        
        console.log(`[Handler] Extracted message ID: ${messageId}`);
        await this.nylasSync.syncMessage(grantId, inboxId, messageId);
      } else if (notificationType.startsWith('thread.replied')) {
        await this.nylasSync.syncThread(inboxId, payload.data);
      } else if (notificationType === 'grant.expired') {
        await this.handleGrantExpired(inboxId, grantId);
      } else {
        console.log(`[Handler] Unhandled notification type: ${notificationType}`);
      }
    } catch (error) {
      console.error(`[Handler] Error processing ${notificationType}:`, error);
      throw error;
    }
  }
  
  private async handleGrantExpired(inboxId: string, grantId: string): Promise<void> {
    console.log(`[Handler] Grant expired for inbox ${inboxId}`);
    
    const { error } = await this.supabase
      .from('support_inboxes')
      .update({
        status: 'auth_expired',
        webhook_health_status: 'failing',
        updated_at: new Date().toISOString(),
      })
      .eq('id', inboxId);
    
    if (error) {
      throw new Error(`Failed to update inbox status: ${error.message}`);
    }
    
    console.log(`[Handler] Marked inbox ${inboxId} as auth_expired`);
  }
}
