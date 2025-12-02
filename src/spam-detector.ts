import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai, OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { config } from './config';
import { SpamDetectionSchema, type SpamDetection } from './spam-detection-schema';

interface ThreadPreview {
  thread_id: string;
  subject: string;
  from_name: string;
  from_email: string;
  preview: string;
  inbox_id: string;
  tenant_id: string;
}

export class SpamDetector {
  private supabase: SupabaseClient;
  private model: any;
  
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
    
    // Use fast, cheap model for spam detection
    const modelName = config.spamDetection.model || 'gpt-4.1';
    if (modelName.startsWith('claude')) {
      this.model = anthropic(modelName);
    } else {
      this.model = openai(modelName);
    }
  }
  
  /**
   * Check if a thread is spam or promotional
   */
  async checkThread(threadId: string): Promise<SpamDetection> {
    console.log(`[SpamDetector] Checking thread ${threadId}`);
    
    // Get thread preview
    const preview = await this.getThreadPreview(threadId);
    
    // Run spam detection with LLM
    const result = await this.detectSpam(preview);
    
    // Update thread in database
    await this.updateThread(threadId, result);
    
    console.log(`[SpamDetector] Thread ${threadId}: spam=${result.is_spam}, promo=${result.is_promotional}, confidence=${result.confidence}`);
    
    return result;
  }
  
  /**
   * Get thread preview for spam detection
   */
  private async getThreadPreview(threadId: string): Promise<ThreadPreview> {
    const { data: thread, error: threadError } = await this.supabase
      .from('support_email_threads')
      .select('id, subject, inbox_id')
      .eq('id', threadId)
      .single();
    
    if (threadError || !thread) {
      throw new Error(`Failed to fetch thread: ${threadError?.message}`);
    }
    
    // Get inbox for tenant_id
    const { data: inbox, error: inboxError } = await this.supabase
      .from('support_inboxes')
      .select('tenant_id')
      .eq('id', thread.inbox_id)
      .single();
    
    if (inboxError || !inbox) {
      throw new Error(`Failed to fetch inbox: ${inboxError?.message}`);
    }
    
    // Get first message for preview
    const { data: messages, error: messageError } = await this.supabase
      .from('support_email_messages')
      .select('sender, body, snippet')
      .eq('thread_id', threadId)
      .order('received_date', { ascending: true })
      .limit(1);
    
    if (messageError || !messages || messages.length === 0) {
      throw new Error(`Failed to fetch messages: ${messageError?.message}`);
    }
    
    const message = messages[0];
    
    // Extract sender info from JSONB
    const sender = message.sender as { name?: string; email?: string } | null;
    const from_name = sender?.name || 'Unknown';
    const from_email = sender?.email || '';
    
    // Create preview (first 200 chars of body or snippet)
    const preview = (message.snippet || message.body || '').slice(0, 200);
    
    return {
      thread_id: threadId,
      subject: thread.subject,
      from_name,
      from_email,
      preview,
      inbox_id: thread.inbox_id,
      tenant_id: inbox.tenant_id,
    };
  }
  
  /**
   * Run LLM spam detection
   */
  private async detectSpam(preview: ThreadPreview): Promise<SpamDetection> {
    try {
      // Determine if we're using OpenAI to conditionally apply strictJsonSchema
      const modelName = config.spamDetection.model || 'gpt-4.1';
      const isOpenAI = !modelName.startsWith('claude');
      
      // Use strictJsonSchema for OpenAI models to enforce schema compliance
      const providerOptions = isOpenAI
        ? { openai: { strictJsonSchema: true } satisfies OpenAIResponsesProviderOptions }
        : undefined;
      
      const { object } = await generateObject({
        model: this.model,
        schema: SpamDetectionSchema,
        prompt: `Analyze this email thread and classify if it's spam or promotional.

Thread Subject: ${preview.subject}
From: ${preview.from_name} <${preview.from_email}>
Preview: ${preview.preview}

DEFINITIONS:
- spam: unsolicited emails, phishing attempts, scams, suspicious senders
- promotional: marketing emails

Be sure not to exclude any company newsletters and updates. The company is New Home Star. 

Return JSON with:
- is_spam (boolean): true if this is spam/phishing/scam
- is_promotional (boolean): true if this is marketing/newsletter/sales
- confidence (0-1): how confident you are in this classification
- reasoning (1 sentence): brief explanation

Be conservative - only mark as spam/promotional if clearly so.`,
        providerOptions,
      });
      
      return object;
      
    } catch (error) {
      console.error('[SpamDetector] LLM error:', error);
      // Default to not spam on error
      return {
        is_spam: false,
        is_promotional: false,
        confidence: 0,
        reasoning: 'Error during detection, defaulting to not spam',
      };
    }
  }
  
  /**
   * Update thread with spam detection results
   */
  private async updateThread(threadId: string, result: SpamDetection): Promise<void> {
    const { error } = await this.supabase
      .from('support_email_threads')
      .update({
        is_spam: result.is_spam,
        is_promotional: result.is_promotional,
        spam_confidence: result.confidence,
        spam_reasoning: result.reasoning,
        spam_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', threadId);
    
    if (error) {
      console.error(`[SpamDetector] Failed to update thread ${threadId}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if thread needs spam detection
   */
  async needsCheck(threadId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('support_email_threads')
      .select('spam_checked_at')
      .eq('id', threadId)
      .single();
    
    if (error) {
      console.error('[SpamDetector] Error checking if needs spam check:', error);
      return true; // Default to needing check on error
    }
    
    return !data.spam_checked_at;
  }
}
