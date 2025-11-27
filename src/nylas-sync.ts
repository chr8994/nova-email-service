import { SupabaseClient } from '@supabase/supabase-js';
import Nylas from 'nylas';
import { config } from './config';

export class NylasSync {
  private nylas: Nylas;
  
  constructor(private supabase: SupabaseClient) {
    this.nylas = new Nylas({
      apiKey: config.nylas.apiKey,
      apiUri: config.nylas.apiUri,
    });
  }
  
  async syncMessage(grantId: string, inboxId: string, messageId: string): Promise<void> {
    console.log(`[Sync] Starting sync for message ${messageId}`);
    
    // Step 1: Check if message already exists in database
    const { data: existingMessage } = await this.supabase
      .from('support_email_messages')
      .select('id, nylas_message_id')
      .eq('nylas_message_id', messageId)
      .single();
    
    if (existingMessage) {
      console.log(`[Sync] Message ${messageId} already exists in database, skipping`);
      return;
    }
    
    // Step 2: Fetch complete message from Nylas API
    console.log(`[Sync] Fetching complete message ${messageId} from Nylas API`);
    const messageResponse = await this.nylas.messages.find({
      identifier: grantId,
      messageId: messageId,
    });
    
    if (!messageResponse.data) {
      throw new Error(`Failed to fetch message ${messageId} from Nylas API`);
    }
    
    const message = messageResponse.data;
    const threadId = message.threadId;
    
    if (!threadId) {
      throw new Error(`Message ${messageId} is missing threadId`);
    }
    
    // Step 3: Check if thread exists in database
    console.log(`[Sync] Checking if thread ${threadId} exists in database`);
    const { data: existingThread } = await this.supabase
      .from('support_email_threads')
      .select('id, nylas_thread_id')
      .eq('nylas_thread_id', threadId)
      .single();
    
    if (!existingThread) {
      // NEW THREAD: Fetch thread details and all messages
      console.log(`[Sync] Thread ${threadId} is NEW, fetching complete thread with all messages`);
      await this.syncNewThread(grantId, inboxId, threadId);
    } else {
      // EXISTING THREAD: Just insert this single message
      console.log(`[Sync] Thread ${threadId} exists (DB ID: ${existingThread.id}), inserting single message`);
      await this.insertMessage(existingThread.id, message);
    }
    
    console.log(`[Sync] Successfully synced message ${messageId}`);
  }
  
  private async syncNewThread(grantId: string, inboxId: string, threadId: string): Promise<void> {
    console.log(`[Sync] Syncing new thread ${threadId}`);
    
    // Step 1: Fetch complete thread details from Nylas API
    console.log(`[Sync] Fetching thread details for ${threadId}`);
    const threadResponse = await this.nylas.threads.find({
      identifier: grantId,
      threadId: threadId,
    });
    
    if (!threadResponse.data) {
      throw new Error(`Failed to fetch thread ${threadId} from Nylas API`);
    }
    
    const thread = threadResponse.data;
    
    // Step 2: Fetch all messages in the thread
    console.log(`[Sync] Fetching all messages for thread ${threadId}`);
    const messagesResponse = await this.nylas.messages.list({
      identifier: grantId,
      queryParams: {
        threadId: threadId,
      },
    });
    
    if (!messagesResponse.data) {
      console.warn(`[Sync] No messages found for thread ${threadId}`);
      return;
    }
    
    const allMessages = messagesResponse.data;
    console.log(`[Sync] Found ${allMessages.length} messages in thread ${threadId}`);
    
    // Step 3: Insert thread (with duplicate check)
    const dbThread = await this.insertThread(inboxId, thread);
    
    // Step 4: Insert all messages (with batch duplicate check)
    await this.insertMessages(dbThread.id, allMessages);
    
    console.log(`[Sync] Successfully synced new thread ${threadId} with ${allMessages.length} messages`);
  }
  
  private async insertThread(inboxId: string, thread: any): Promise<any> {
    // Double-check thread doesn't exist (defensive programming)
    const { data: existing } = await this.supabase
      .from('support_email_threads')
      .select('id, nylas_thread_id')
      .eq('nylas_thread_id', thread.id)
      .single();
    
    if (existing) {
      console.log(`[Sync] Thread ${thread.id} already exists (DB ID: ${existing.id}), skipping insert`);
      return existing;
    }
    
    // Insert new thread
    const { data: dbThread, error: threadError } = await this.supabase
      .from('support_email_threads')
      .insert({
        inbox_id: inboxId,
        nylas_thread_id: thread.id,
        subject: thread.subject || '(No Subject)',
        snippet: thread.snippet || '',
        participants: thread.participants || [],
        latest_message_received_date: thread.latestDraftOrMessage?.date
          ? new Date(thread.latestDraftOrMessage.date * 1000).toISOString()
          : new Date().toISOString(),
        unread: thread.unread ?? false,
        starred: thread.starred ?? false,
      })
      .select()
      .single();
    
    if (threadError) {
      throw new Error(`Failed to insert thread ${thread.id}: ${threadError.message}`);
    }
    
    console.log(`[Sync] Inserted thread ${thread.id} (DB ID: ${dbThread.id})`);
    return dbThread;
  }
  
  private async insertMessages(threadDbId: string, messages: any[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    
    // Step 1: Get all message IDs that already exist in database
    const messageIds = messages.map(msg => msg.id);
    const { data: existingMessages } = await this.supabase
      .from('support_email_messages')
      .select('nylas_message_id')
      .in('nylas_message_id', messageIds);
    
    const existingMessageIds = new Set(
      existingMessages?.map(m => m.nylas_message_id) || []
    );
    
    // Step 2: Filter out messages that already exist
    const messagesToInsert = messages.filter(msg => !existingMessageIds.has(msg.id));
    
    if (messagesToInsert.length === 0) {
      console.log(`[Sync] All ${messages.length} messages already exist, skipping insert`);
      return;
    }
    
    console.log(`[Sync] Inserting ${messagesToInsert.length} new messages (${existingMessageIds.size} already exist)`);
    console.log(`[Sync] ================================================`);
    
    // Step 3: Prepare message records and log details
    const messageRecords = [];
    for (let i = 0; i < messagesToInsert.length; i++) {
      const message = messagesToInsert[i];
      
      // Log detailed message information
      const sender = message.from?.[0];
      const senderDisplay = sender 
        ? `${sender.name || sender.email} <${sender.email}>`
        : 'Unknown Sender';
      
      const receivedDate = message.date 
        ? new Date(message.date * 1000).toLocaleString()
        : 'Unknown Date';
      
      const toRecipients = (message.to || [])
        .map((r: any) => r.email)
        .join(', ') || 'None';
      
      console.log(`[Sync] Message ${i + 1}/${messagesToInsert.length}:`);
      console.log(`[Sync]   Subject: ${message.subject || '(No Subject)'}`);
      console.log(`[Sync]   From: ${senderDisplay}`);
      console.log(`[Sync]   To: ${toRecipients}`);
      console.log(`[Sync]   Date: ${receivedDate}`);
      console.log(`[Sync]   Snippet: ${(message.snippet || '').substring(0, 100)}...`);
      console.log(`[Sync]   Unread: ${message.unread ?? true}`);
      console.log(`[Sync]   Attachments: ${(message.attachments || []).length}`);
      console.log(`[Sync] ------------------------------------------------`);
      
      // Add delay between message processing
      if (i < messagesToInsert.length - 1) {
        await this.delay(config.processing.messageDelayMs);
      }
      
      messageRecords.push({
        thread_id: threadDbId,
        nylas_message_id: message.id,
        subject: message.subject || '(No Subject)',
        sender: message.from?.[0] || { email: 'unknown@example.com' },
        body: message.body || '',
        received_date: message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString(),
        to_recipients: message.to || [],
        cc_recipients: message.cc || [],
        bcc_recipients: message.bcc || [],
        reply_to: message.replyTo || [],
        attachments: message.attachments || [],
        folders: message.folders || [],
        unread: message.unread ?? true,
        starred: message.starred ?? false,
        snippet: message.snippet || '',
        headers: message.headers || [],
        in_reply_to: (message as any).in_reply_to || null,
        metadata: (message as any).metadata || null,
        tracking_options: message.trackingOptions || null,
      });
    }
    
    // Step 4: Batch insert messages
    console.log(`[Sync] Saving ${messageRecords.length} messages to database...`);
    const { error: insertError } = await this.supabase
      .from('support_email_messages')
      .insert(messageRecords);
    
    if (insertError) {
      throw new Error(`Failed to insert messages: ${insertError.message}`);
    }
    
    console.log(`[Sync] ✓ Successfully inserted ${messagesToInsert.length} messages`);
    console.log(`[Sync] ================================================`);
  }
  
  private async insertMessage(threadDbId: string, message: any): Promise<void> {
    // Double-check message doesn't exist (defensive programming)
    const { data: existing } = await this.supabase
      .from('support_email_messages')
      .select('id, nylas_message_id')
      .eq('nylas_message_id', message.id)
      .single();
    
    if (existing) {
      console.log(`[Sync] Message ${message.id} already exists (DB ID: ${existing.id}), skipping insert`);
      return;
    }
    
    // Insert new message
    const sender = message.from?.[0] || { email: 'unknown@example.com' };
    
    const { error: insertError } = await this.supabase
      .from('support_email_messages')
      .insert({
        thread_id: threadDbId,
        nylas_message_id: message.id,
        subject: message.subject || '(No Subject)',
        sender,
        body: message.body || '',
        received_date: message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString(),
        to_recipients: message.to || [],
        cc_recipients: message.cc || [],
        bcc_recipients: message.bcc || [],
        reply_to: message.replyTo || [],
        attachments: message.attachments || [],
        folders: message.folders || [],
        unread: message.unread ?? true,
        starred: message.starred ?? false,
        snippet: message.snippet || '',
        headers: message.headers || [],
        in_reply_to: (message as any).in_reply_to || null,
        metadata: (message as any).metadata || null,
        tracking_options: message.trackingOptions || null,
      });
    
    if (insertError) {
      throw new Error(`Failed to insert message ${message.id}: ${insertError.message}`);
    }
    
    console.log(`[Sync] Inserted message ${message.id}`);
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  async syncThread(inboxId: string, threadData: any): Promise<void> {
    if (!threadData?.id) {
      console.error('[Sync] Thread data missing or missing ID', {
        hasThreadData: !!threadData,
      });
      throw new Error('Missing thread data or thread ID');
    }
    
    // Upsert the thread
    const { error: threadError } = await this.supabase
      .from('support_email_threads')
      .upsert(
        {
          inbox_id: inboxId,
          nylas_thread_id: threadData.id,
          subject: threadData.subject || '(No Subject)',
          snippet: threadData.snippet || '',
          participants: threadData.participants || [],
          latest_message_received_date: threadData.date
            ? new Date(threadData.date * 1000).toISOString()
            : new Date().toISOString(),
          unread: threadData.unread || false,
          starred: threadData.starred || false,
        },
        {
          onConflict: 'nylas_thread_id',
          ignoreDuplicates: false,
        }
      );
    
    if (threadError) {
      throw new Error(`Failed to upsert thread: ${threadError.message}`);
    }
    
    console.log(`[Sync] Synced thread ${threadData.id}`);
  }
}
