import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import { openai, OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { config } from './config';
import { UniversalExtractionSchema, UniversalExtraction, Entity } from './extraction-schema';

interface QueueJob {
  id: string;
  message_id?: string; // Legacy
  thread_id: string;   // New requirement
  tenant_id: string;
  inbox_id: string;
  status: string;
  priority: number;
  retry_count: number;
  max_retries: number;
  queued_at: string;
}

interface EmailMessage {
  id: string;
  thread_id: string;
  nylas_message_id: string;
  subject: string;
  sender: any;
  body: string;
  received_date: string;
  to_recipients: any;
  cc_recipients: any;
  in_reply_to: string;
  snippet: string;
  headers: any;
}

export class ExtractionWorker {
  private supabase: SupabaseClient;
  private isRunning = false;
  private readonly POLL_INTERVAL_MS: number;
  private readonly MAX_RETRIES: number;
  private readonly TIMEOUT_MS: number;
  private readonly LLM_PROVIDER: string;
  private readonly LLM_MODEL: string;
  private readonly TEMPERATURE: number;
  private totalProcessed = 0;
  private totalFailed = 0;
  
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
    
    this.POLL_INTERVAL_MS = config.extraction.pollIntervalMs;
    this.MAX_RETRIES = config.extraction.maxRetries;
    this.TIMEOUT_MS = config.extraction.timeoutMs;
    this.LLM_PROVIDER = config.extraction.llmProvider;
    this.LLM_MODEL = config.extraction.llmModel;
    this.TEMPERATURE = config.extraction.temperature;
  }
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[ExtractionWorker] Already running');
      return;
    }
    
    if (!config.extraction.enabled) {
      console.log('[ExtractionWorker] Disabled by configuration');
      return;
    }
    
    this.isRunning = true;
    console.log('[ExtractionWorker] Starting extraction worker');
    console.log(`[ExtractionWorker] Provider: ${this.LLM_PROVIDER}, Model: ${this.LLM_MODEL}`);
    console.log(`[ExtractionWorker] Poll interval: ${this.POLL_INTERVAL_MS}ms, Max retries: ${this.MAX_RETRIES}`);
    
    // Start continuous polling loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[ExtractionWorker] Stopping extraction worker');
    this.isRunning = false;
    console.log(`[ExtractionWorker] Stopped. Processed: ${this.totalProcessed}, Failed: ${this.totalFailed}`);
  }
  
  private async runWorker(): Promise<void> {
    console.log('[ExtractionWorker] Worker started. Listening for queued messages...');
    
    // Continuously poll for queued messages
    while (this.isRunning) {
      try {
        await this.processNextJob();
        
        // Wait before next poll
        await this.delay(this.POLL_INTERVAL_MS);
        
      } catch (error) {
        console.error('[ExtractionWorker] Worker error:', error);
        await this.delay(5000);
      }
    }
  }
  
  private async processNextJob(): Promise<void> {
    try {
      // Use PGMQ if enabled, otherwise fall back to table polling
      if (config.pgmq.enabled) {
        await this.processNextJobFromPGMQ();
      } else {
        await this.processNextJobFromTable();
      }
    } catch (error) {
      console.error('[ExtractionWorker] Error in processNextJob:', error);
    }
  }
  
  private async processNextJobFromPGMQ(): Promise<void> {
    try {
      // Read from PGMQ with visibility timeout
      const { data: jobs, error } = await this.supabase
        .schema('pgmq_public')
        .rpc('read', {
          queue_name: 'email_extraction_jobs',
          sleep_seconds: Math.floor(config.pgmq.visibilityTimeout / 60), // Convert to minutes
          n: 1
        });
      
      if (error) {
        console.error('[ExtractionWorker] Error reading from PGMQ:', error);
        return;
      }
      
      if (!jobs || jobs.length === 0) {
        // No jobs - this is normal
        return;
      }
      
      const pgmqJob = jobs[0];
      const jobData = pgmqJob.message;
      
      // Process the job
      await this.processJobFromPGMQ(pgmqJob.msg_id, jobData);
      
    } catch (error) {
      console.error('[ExtractionWorker] Error in processNextJobFromPGMQ:', error);
    }
  }
  
  private async processNextJobFromTable(): Promise<void> {
    try {
      // Get next job from queue table (legacy mode)
      const { data: jobs, error } = await this.supabase
        .from('email_extraction_queue')
        .select('*')
        .eq('status', 'queued')
        .order('priority', { ascending: false })
        .order('queued_at', { ascending: true })
        .limit(1);
      
      if (error) {
        console.error('[ExtractionWorker] Error reading queue:', error);
        return;
      }
      
      if (!jobs || jobs.length === 0) {
        // No jobs to process - this is normal
        return;
      }
      
      const job = jobs[0] as QueueJob;
      await this.processJob(job);
      
    } catch (error) {
      console.error('[ExtractionWorker] Error in processNextJobFromTable:', error);
    }
  }
  
  private async processJobFromPGMQ(msgId: number, jobData: any): Promise<void> {
    const startTime = Date.now();
    const threadId = jobData.thread_id;
    const inboxId = jobData.inbox_id;
    const tenantId = jobData.tenant_id;
    
    try {
      console.log(`[ExtractionWorker] Processing thread ${threadId} from PGMQ (msg_id: ${msgId})`);
      
      // Fetch all thread messages
      const messages = await this.fetchThreadMessages(threadId);
      
      if (!messages || messages.length === 0) {
        console.error(`[ExtractionWorker] No messages found for thread ${threadId}`);
        // Acknowledge anyway to remove from queue
        await this.acknowledgePGMQJob(msgId, threadId);
        return;
      }
      
      console.log(`[ExtractionWorker] Thread ${threadId} has ${messages.length} messages`);
      
      // Extract with LLM
      const extraction = await this.extractWithLLM(messages);
      
      // Save extraction results
      await this.saveExtraction(threadId, inboxId, tenantId, messages, extraction);
      
      // Acknowledge job (removes from PGMQ and updates thread status)
      await this.acknowledgePGMQJob(msgId, threadId);
      
      const processingTime = Date.now() - startTime;
      console.log(`[ExtractionWorker] ✓ Completed thread ${threadId} in ${processingTime}ms`);
      this.totalProcessed++;
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      console.error(`[ExtractionWorker] Error processing PGMQ job for thread ${threadId}:`, error);
      
      // Don't acknowledge - job will re-appear after visibility timeout for retry
      console.log(`[ExtractionWorker] Job will retry after visibility timeout (${config.pgmq.visibilityTimeout}s)`);
    }
  }
  
  private async acknowledgePGMQJob(msgId: number, threadId: string): Promise<void> {
    try {
      await this.supabase.rpc('acknowledge_extraction_job', {
        p_msg_id: msgId,
        p_thread_id: threadId
      });
    } catch (error) {
      console.error('[ExtractionWorker] Error acknowledging PGMQ job:', error);
    }
  }
  
  private async processJob(job: QueueJob): Promise<void> {
    const startTime = Date.now();
    
    // Check retry limit
    if (job.retry_count >= this.MAX_RETRIES) {
      console.log(`[ExtractionWorker] Job ${job.id} exceeded retry limit (${job.retry_count} attempts)`);
      await this.markFailed(job.id, job.thread_id, 'Exceeded maximum retry attempts');
      this.totalFailed++;
      return;
    }
    
    try {
      console.log(`[ExtractionWorker] Processing thread ${job.thread_id} (priority: ${job.priority}, attempt: ${job.retry_count + 1})`);
      
      // Mark as processing
      await this.markProcessing(job.id, job.thread_id);
      
      // Fetch all thread messages
      const messages = await this.fetchThreadMessages(job.thread_id);
      
      if (!messages || messages.length === 0) {
        await this.markFailed(job.id, job.thread_id, 'No messages found in thread');
        this.totalFailed++;
        return;
      }

      console.log(`[ExtractionWorker] Thread ${job.thread_id} has ${messages.length} messages`);
      
      // Extract with LLM analyzing the whole thread
      const extraction = await this.extractWithLLM(messages);
      
      // Save extraction results
      await this.saveExtraction(job.thread_id, job.inbox_id, job.tenant_id, messages, extraction);
      
      // Mark as completed
      const processingTime = Date.now() - startTime;
      await this.markCompleted(job.id, job.thread_id, processingTime);
      
      console.log(`[ExtractionWorker] ✓ Completed thread ${job.thread_id} in ${processingTime}ms`);
      this.totalProcessed++;
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      console.error(`[ExtractionWorker] Error processing job ${job.id}:`, error);
      
      // Increment retry count
      await this.markRetrying(job.id, errorMessage);
      
      console.log(`[ExtractionWorker] Job will retry (attempt ${job.retry_count + 2}/${this.MAX_RETRIES}) after ${processingTime}ms`);
    }
  }
  
  private async fetchThreadMessages(threadId: string): Promise<EmailMessage[]> {
    try {
      const { data, error } = await this.supabase
        .from('support_email_messages')
        .select('*')
        .eq('thread_id', threadId)
        .order('received_date', { ascending: true }); // Oldest first for transcript
      
      if (error) {
        console.error(`[ExtractionWorker] Error fetching messages for thread ${threadId}:`, error);
        return [];
      }
      
      return (data || []) as EmailMessage[];
    } catch (error) {
      console.error('[ExtractionWorker] Error in fetchThreadMessages:', error);
      return [];
    }
  }
  
  private async extractWithLLM(messages: EmailMessage[]): Promise<UniversalExtraction> {
    const prompt = this.formatExtractionPrompt(messages);
    
    console.log(`[ExtractionWorker] Calling ${this.LLM_PROVIDER}/${this.LLM_MODEL} (transcript length: ${prompt.length})...`);
    
    // Select model based on provider
    const model = this.LLM_PROVIDER === 'anthropic' 
      ? anthropic(this.LLM_MODEL)
      : openai(this.LLM_MODEL);
    
    try {
      // Use strictJsonSchema for OpenAI models to enforce schema compliance
      const providerOptions = this.LLM_PROVIDER === 'openai'
        ? { openai: { strictJsonSchema: true } satisfies OpenAIResponsesProviderOptions }
        : undefined;
      
      const result = await generateObject({
        model: model,
        schema: UniversalExtractionSchema,
        schemaName: 'EmailThreadExtraction',
        schemaDescription: 'Extract structured intelligence from email thread history',
        prompt: prompt,
        temperature: this.TEMPERATURE,
        providerOptions,
      });
      
      console.log(`[ExtractionWorker] LLM extraction successful (tokens: ${result.usage?.totalTokens || 'unknown'})`);
      
      return result.object as UniversalExtraction;
      
    } catch (error) {
      console.error('[ExtractionWorker] LLM extraction error:', error);
      throw new Error(`LLM extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  private formatExtractionPrompt(messages: EmailMessage[]): string {
    // Sort messages strictly by date
    const sortedMessages = [...messages].sort((a, b) => 
      new Date(a.received_date).getTime() - new Date(b.received_date).getTime()
    );
    
    const latestMessage = sortedMessages[sortedMessages.length - 1];
    const messageCount = sortedMessages.length;
    
    // Build thread transcript
    const transcript = sortedMessages.map((msg, index) => {
      const senderInfo = msg.sender 
        ? `${msg.sender.name || 'Unknown'} <${msg.sender.email || 'unknown@example.com'}>`
        : 'Unknown sender';
        
      const timestamp = new Date(msg.received_date).toLocaleString();
      
      // Clean body snippet (first 500 chars if long)
      let bodyContent = msg.body || msg.snippet || 'No content';
      if (bodyContent.length > 2000) {
        bodyContent = bodyContent.substring(0, 2000) + '... [truncated]';
      }
      
      return `
--- MESSAGE ${index + 1} of ${messageCount} ---
From: ${senderInfo}
Date: ${timestamp}
Subject: ${msg.subject || 'No subject'}
To: ${(msg.to_recipients || []).map((r: any) => r.email).join(', ')}

${bodyContent}
`;
    }).join('\n');

    return `
# Email Thread Intelligence Extraction

You are an AI assistant developed by New Home Star specialized in extracting structured intelligence from email conversations of an employee inbox.

## Task
Analyze the full email thread below and extract structured data representing the CURRENT STATE of the conversation.
Focus extraction on the LATEST context, but use history to inform intent, status, and next steps.

## Thread Context
- **Total Messages**: ${messageCount}
- **Latest Subject**: ${latestMessage.subject || 'No subject'}
- **Participants**: Multiple senders and recipients

## Thread Transcript
${transcript}

## Instructions
1. **Summary**: Provide a concise summary of the ENTIRE conversation, focusing on the outcome/current status.
2. **Intent**: The primary goal of the LATEST message or the overall thread purpose.
3. **Category**: The content type (e.g., billing, scheduling, customer_support).
4. **Sentiment**: Overall sentiment of the conversation (positive, neutral, negative, or mixed).
5. **Tone**: The tone of the message (formal, casual, urgent, friendly, professional, or other).
6. **Urgency**: Score 0-10 based on the LATEST context.
7. **Tasks**: Extract actionable items that are STILL RELEVANT (ignore completed requests).
8. **Entities**: Identify people, companies, dates, etc. across the thread.
9. **Project**: Is this a long-running specific project/topic?
10. **Participants**: List all unique participants with their roles if discernable.

IMPORTANT: 
- Treat the conversation as a single unit of work.
- Respond based on the MOST RECENT state of affairs.
- For 'sender_type', classify the LATEST sender.
- For 'is_reply', true if thread length > 1.
`;
  }
  
  private async saveExtraction(
    threadId: string,
    inboxId: string,
    tenantId: string,
    messages: EmailMessage[],
    extraction: UniversalExtraction
  ): Promise<void> {
    try {
      // Get latest message for reference
      const sortedMessages = [...messages].sort((a, b) => 
        new Date(a.received_date).getTime() - new Date(b.received_date).getTime()
      );
      const latestMessage = sortedMessages[sortedMessages.length - 1];
      
      // Calculate word count for token estimation
      const totalWordCount = messages.reduce((sum, msg) => 
        sum + (msg.body ? msg.body.split(/\s+/).length : 0), 0);
      const estimatedTokens = Math.ceil(totalWordCount / 0.75);
      
      // Determine characteristics
      const isReply = messages.length > 1 || extraction.is_reply;
      const isForward = latestMessage.subject?.toLowerCase().includes('fwd:') || extraction.is_forward;
      const isHumanSender = extraction.sender_type === 'person';
      const isMachineGenerated = extraction.sender_type === 'automated_system' || extraction.sender_type === 'marketing_platform';
      
      // Insert extraction linked to THREAD
      const { data: extractionData, error: extractionError } = await this.supabase
        .from('email_extractions')
        .insert({
          // Link to thread
          thread_id: threadId,
          // Also link to latest message for compatibility (optional, based on schema)
          // message_id: latestMessage.id, // Optional if schema allows NULL
          
          inbox_id: inboxId,
          tenant_id: tenantId,
          
          // Thread-specific fields
          extraction_type: 'thread',
          message_count: messages.length,
          thread_summary: extraction.thread_summary || extraction.summary,
          participants: extraction.participants,
          
          // Core fields (represent current state)
          summary: extraction.summary,
          intent: extraction.intent,
          urgency: extraction.urgency.toString(),
          sentiment: extraction.sentiment,
          needs_reply: extraction.needs_reply,
          actionability: extraction.actionability,
          reply_expectation: extraction.reply_expectation,
          
          // Scoring
          signal_score: extraction.signal_score,
          importance_score: extraction.importance_score,
          
          // Classification
          message_class: extraction.message_class,
          sender_type: extraction.sender_type,
          category: extraction.category,
          
          // Text analysis
          tone: extraction.tone,
          language: extraction.language,
          task_likelihood: extraction.task_likelihood / 10,
          
          // Arrays
          tasks: extraction.tasks,
          risks: extraction.risks,
          topic_keywords: extraction.topic_keywords,
          external_links: extraction.external_links,
          
          // Metrics
          token_count: estimatedTokens,
          reading_time_seconds: extraction.reading_time_seconds,
          
          // Conversation context
          nylas_thread_id: latestMessage.thread_id,
          nylas_message_id: latestMessage.nylas_message_id,
          in_reply_to: latestMessage.in_reply_to,
          is_human_sender: isHumanSender,
          is_machine_generated: isMachineGenerated,
          is_reply: isReply,
          is_forward: isForward,
          thread_position: 'latest',
          message_type: extraction.message_type,
          
          // Project detection
          project_detected: !!extraction.project_label,
          project_label: extraction.project_label,
          project_confidence: extraction.project_confidence,
          
          // Metadata
          raw_extraction_result: extraction,
          extraction_model: `${this.LLM_PROVIDER}/${this.LLM_MODEL}`,
          extraction_version: '2.0.0', // Bumped version for thread support
        })
        .select()
        .single();
      
      if (extractionError) {
        // If unique constraint fails, we might want to update the existing extraction
        if (extractionError.code === '23505') { // unique_violation
          console.log(`[ExtractionWorker] Updating existing thread extraction for ${threadId}`);
          // Logic to update existing record would go here
          // For now, we'll just log it and proceed
        } else {
          throw extractionError;
        }
      }
      
      // Save entities if new extraction created
      if (extractionData && extraction.entities && extraction.entities.length > 0) {
        await this.saveEntities(extractionData.id, extraction.entities, latestMessage.id);
      }
      
      // Upgrade: Mark ALL messages in thread as completed
      const messageIds = messages.map(m => m.id);
      if (messageIds.length > 0) {
        await this.supabase
          .from('support_email_messages')
          .update({
            extraction_status: 'completed',
            extracted_at: new Date().toISOString()
          })
          .in('id', messageIds);
      }
      
      console.log(`[ExtractionWorker] Saved thread extraction for ${threadId} (${messages.length} messages updated)`);
      
    } catch (error) {
      console.error('[ExtractionWorker] Error saving extraction:', error);
      throw error;
    }
  }
  
  private async saveEntities(extractionId: string, entities: Entity[], latestMessageId: string): Promise<void> {
    try {
      const entityRecords = entities.map(entity => ({
        extraction_id: extractionId,
        entity_type: entity.entity_type,
        entity_value: entity.entity_value,
        person_name: entity.entity_type === 'person' ? entity.entity_value : null,
        person_confidence: entity.confidence ? parseInt(entity.confidence) : null,
        person_source: 'body',
        person_role_hint: entity.entity_context,
        source_message_id: latestMessageId // Associate with latest message for now
      }));
      
      const { error } = await this.supabase
        .from('email_extraction_entities')
        .insert(entityRecords);
      
      if (error) {
        console.error('[ExtractionWorker] Error saving entities:', error);
      }
    } catch (error) {
      console.error('[ExtractionWorker] Error in saveEntities:', error);
    }
  }
  
  private async markProcessing(queueId: string, threadId: string): Promise<void> {
    try {
      await this.supabase
        .from('email_extraction_queue')
        .update({
          status: 'processing',
          started_at: new Date().toISOString()
        })
        .eq('id', queueId);
        
      // Also update thread status
      await this.supabase
        .from('support_email_threads')
        .update({
          extraction_status: 'processing'
        })
        .eq('id', threadId);
        
    } catch (error) {
      console.error('[ExtractionWorker] Error marking processing:', error);
    }
  }
  
  private async markCompleted(queueId: string, threadId: string, processingTimeMs: number): Promise<void> {
    try {
      // Remove from queue entirely (or mark completed)
      await this.supabase
        .from('email_extraction_queue')
        .delete() // Delete to keep queue clean
        .eq('id', queueId);
      
      // Update thread status
      await this.supabase
        .from('support_email_threads')
        .update({
          extraction_status: 'completed',
          extracted_at: new Date().toISOString()
        })
        .eq('id', threadId);
        
    } catch (error) {
      console.error('[ExtractionWorker] Error marking completed:', error);
    }
  }
  
  private async markRetrying(queueId: string, errorMessage: string): Promise<void> {
    try {
      const { data } = await this.supabase
        .from('email_extraction_queue')
        .select('retry_count')
        .eq('id', queueId)
        .single();
      
      const newRetryCount = (data?.retry_count || 0) + 1;
      
      await this.supabase
        .from('email_extraction_queue')
        .update({
          status: 'queued', // Back to queued for retry
          retry_count: newRetryCount,
          error_message: errorMessage,
        })
        .eq('id', queueId);
    } catch (error) {
      console.error('[ExtractionWorker] Error marking retry:', error);
    }
  }
  
  private async markFailed(queueId: string, threadId: string, errorMessage: string): Promise<void> {
    try {
      await this.supabase
        .from('email_extraction_queue')
        .update({
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        })
        .eq('id', queueId);
        
      // Update thread status
      await this.supabase
        .from('support_email_threads')
        .update({
          extraction_status: 'failed',
          extraction_error: errorMessage
        })
        .eq('id', threadId);
        
    } catch (error) {
      console.error('[ExtractionWorker] Error marking failed:', error);
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
