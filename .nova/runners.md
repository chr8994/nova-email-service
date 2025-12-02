# Email Extraction System - Workers Implementation Plan

## Overview

This document outlines the implementation plan for two new workers that will implement the Universal Email Extraction System described in the architecture documentation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Incoming Email Flow                           │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│              support_email_messages (Storage)                    │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│         ExtractionQueueProcessor (Worker 1 - NEW)               │
│  • Continuously polls for unprocessed messages                  │
│  • Calculates priority (newer = higher)                         │
│  • Inserts into email_extraction_queue                          │
│  • Processes 10 messages per batch                              │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│          email_extraction_queue (Database Table)                 │
│  • status: 'queued' | 'processing' | 'completed' | 'failed'     │
│  • priority: 0-100 (based on message age)                       │
│  • retry_count, error_message, etc.                             │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│           ExtractionWorker (Worker 2 - NEW)                      │
│  • Reads from email_extraction_queue (ORDER BY priority DESC)   │
│  • Calls LLM with Universal Schema (Vercel AI SDK)              │
│  • Validates response with Zod schema                           │
│  • Saves to email_extractions table                             │
│  • Handles retries and failures                                 │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│           email_extractions (Results Table)                      │
│           email_extraction_entities (Normalized Entities)        │
│           email_projects (Clustering/Grouping)                   │
└─────────────────────────────────────────────────────────────────┘
```

## Worker 1: ExtractionQueueProcessor

### Purpose
Continuously monitor for unprocessed email messages and queue them for AI extraction.

### Responsibilities
1. **Discovery**: Find messages that haven't been extracted yet
2. **Priority Calculation**: Assign priority based on message age (newer = higher)
3. **Queueing**: Insert messages into `email_extraction_queue` table
4. **Deduplication**: Avoid queueing messages already in queue
5. **Batch Processing**: Process 10 messages at a time

### Key Features

#### Priority Algorithm
```typescript
/**
 * Calculate priority based on message age
 * - Last 24 hours: 80-100 (Critical)
 * - Last 7 days: 50-79 (High)
 * - Last 30 days: 20-49 (Normal)
 * - Older than 30 days: 0-19 (Low)
 */
function calculatePriority(receivedDate: Date): number {
  const ageMs = Date.now() - receivedDate.getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  
  if (ageHours < 24) {
    // Last 24 hours: 80-100
    return Math.max(80, Math.round(100 - (ageHours / 24) * 20));
  } else if (ageHours < 168) { // 7 days
    // Last 7 days: 50-79
    return Math.max(50, Math.round(80 - ((ageHours - 24) / 144) * 30));
  } else if (ageHours < 720) { // 30 days
    // Last 30 days: 20-49
    return Math.max(20, Math.round(50 - ((ageHours - 168) / 552) * 30));
  } else {
    // Older than 30 days: 0-19
    return Math.max(0, Math.round(20 - Math.min(20, (ageHours - 720) / 720 * 20)));
  }
}
```

#### Discovery Query
```sql
-- Find messages without extractions
SELECT 
  m.id,
  m.inbox_id,
  m.thread_id,
  m.received_date,
  m.tenant_id,
  m.subject,
  m.snippet
FROM support_email_messages m
LEFT JOIN email_extractions e ON e.message_id = m.id
WHERE e.id IS NULL  -- No extraction exists
  AND m.received_date IS NOT NULL
  AND m.body IS NOT NULL  -- Has content to extract
ORDER BY m.received_date DESC  -- Newest first
LIMIT 10;
```

#### Deduplication Check
```sql
-- Check if message already queued
SELECT id 
FROM email_extraction_queue
WHERE message_id = $1
  AND status IN ('queued', 'processing')
LIMIT 1;
```

### Class Structure

```typescript
export class ExtractionQueueProcessor {
  private supabase: SupabaseClient;
  private isRunning = false;
  private readonly BATCH_SIZE = 10;
  private readonly POLL_INTERVAL_MS = 15000; // 15 seconds
  
  constructor();
  
  // Lifecycle methods
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  // Core processing
  private async runWorker(): Promise<void>;
  private async processMessageBatch(): Promise<void>;
  
  // Helper methods
  private calculatePriority(receivedDate: Date): number;
  private async checkIfQueued(messageId: string): Promise<boolean>;
  private async queueMessage(message: Message, priority: number): Promise<void>;
  private delay(ms: number): Promise<void>;
}
```

### Configuration

```typescript
// In src/config.ts
extractionQueue: {
  enabled: boolean;              // Enable/disable queue processor
  pollIntervalMs: number;        // Polling interval (default: 15000)
  batchSize: number;             // Messages per batch (default: 10)
}
```

### Environment Variables

```env
# Extraction Queue Processor
EXTRACTION_QUEUE_ENABLED=true
EXTRACTION_QUEUE_POLL_INTERVAL_MS=15000
EXTRACTION_QUEUE_BATCH_SIZE=10
```

### Statistics Logged
- Messages found per batch
- Messages queued successfully
- Messages skipped (already queued)
- Priority distribution
- Total queued since startup
- Errors encountered

---

## Worker 2: ExtractionWorker

### Purpose
Process queued messages by calling LLM to extract structured intelligence and save results.

### Responsibilities
1. **Queue Reading**: Pull messages from queue (highest priority first)
2. **LLM Processing**: Call AI SDK with Universal Extraction Schema
3. **Validation**: Validate LLM response against Zod schema
4. **Storage**: Save results to email_extractions, entities, projects tables
5. **Error Handling**: Implement retry logic with exponential backoff
6. **Status Updates**: Update queue status throughout processing

### Universal Extraction Schema

```typescript
import { z } from 'zod';

// Intent classification
const IntentSchema = z.enum([
  'request',
  'question',
  'complaint',
  'approval',
  'status_update',
  'scheduling',
  'follow_up',
  'information',
  'thank_you',
  'marketing',
  'newsletter',
  'announcement',
  'system_alert',
  'promotion'
]);

// Message classification
const MessageClassSchema = z.enum([
  'transactional_notification',
  'vendor_marketing',
  'system_alert',
  'newsletter',
  'conversational_email',
  'automated_promo'
]);

// Sender type
const SenderTypeSchema = z.enum([
  'person',
  'company',
  'automated_system',
  'marketing_platform'
]);

// Category
const CategorySchema = z.enum([
  'account_notification',
  'billing',
  'marketing_promo',
  'product_update',
  'task_request',
  'scheduling',
  'alert_or_error',
  'conversation',
  'documentation',
  'legal_or_compliance',
  'customer_support'
]);

// Entity type
const EntityTypeSchema = z.enum([
  'person',
  'company',
  'email',
  'date',
  'time',
  'address',
  'amount',
  'phone_number',
  'other'
]);

// Main extraction schema
export const UniversalExtractionSchema = z.object({
  // Core fields
  summary: z.string().describe('Brief summary of the email (2-3 sentences)'),
  intent: IntentSchema.describe('Primary intent of the message'),
  urgency: z.number().min(0).max(10).describe('Urgency score (0-10, 10 is most urgent)'),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']).describe('Overall sentiment'),
  needs_reply: z.boolean().describe('Does this message require a response?'),
  
  // Scoring
  signal_score: z.number().min(0).max(100).describe('Signal-to-noise ratio (0-100)'),
  importance_score: z.number().min(0).max(100).describe('User-specific importance (0-100)'),
  
  // Classification
  message_class: MessageClassSchema.describe('Type of message'),
  sender_type: SenderTypeSchema.describe('Type of sender'),
  category: CategorySchema.describe('Content category'),
  
  // Text analysis
  tone: z.enum(['formal', 'casual', 'urgent', 'friendly', 'professional', 'other']).describe('Tone of message'),
  language: z.string().describe('Detected language code (e.g., "en", "es")'),
  task_likelihood: z.number().min(0).max(10).describe('Likelihood this contains actionable tasks (0-10)'),
  
  // Arrays
  tasks: z.array(z.string()).describe('List of actionable tasks mentioned'),
  risks: z.array(z.string()).describe('Potential risks or concerns identified'),
  topic_keywords: z.array(z.string()).describe('Key topics/keywords (3-10 words)'),
  external_links: z.array(z.string()).describe('External URLs mentioned'),
  
  // Entities
  entities: z.array(z.object({
    entity_type: EntityTypeSchema,
    entity_value: z.string(),
    entity_context: z.string().optional(),
    confidence: z.number().min(0).max(10).optional()
  })).describe('Named entities extracted from the message'),
  
  // Project detection
  project_label: z.string().optional().describe('Human-readable project name if detected'),
  project_confidence: z.number().min(0).max(1).optional().describe('Confidence in project match (0-1)'),
  
  // Metrics
  reading_time_seconds: z.number().describe('Estimated reading time in seconds'),
  
  // Conversation context
  is_reply: z.boolean().describe('Is this a reply to another message?'),
  is_forward: z.boolean().describe('Is this a forwarded message?'),
  message_type: z.enum(['initial', 'reply', 'forward', 'automated']).describe('Type of message in conversation')
});

export type UniversalExtraction = z.infer<typeof UniversalExtractionSchema>;
```

### LLM Processing Flow

```typescript
async function processMessage(message: EmailMessage): Promise<UniversalExtraction> {
  // 1. Format message content for LLM
  const prompt = formatExtractionPrompt(message);
  
  // 2. Call LLM with structured output
  const result = await generateObject({
    model: openai('gpt-4o'), // or anthropic('claude-3-5-sonnet-20241022')
    schema: UniversalExtractionSchema,
    schemaName: 'EmailExtraction',
    schemaDescription: 'Extract structured intelligence from email message',
    prompt: prompt,
    temperature: 0.1, // Low temperature for consistency
  });
  
  // 3. Return validated result
  return result.object;
}
```

### Prompt Template

```typescript
function formatExtractionPrompt(message: EmailMessage): string {
  return `
# Email Intelligence Extraction

You are an AI assistant specialized in extracting structured intelligence from email messages.

## Task
Analyze the following email and extract structured data according to the schema provided.

## Email Details
- **From**: ${message.sender_name} <${message.sender_email}>
- **To**: ${message.recipient_email}
- **Subject**: ${message.subject}
- **Received**: ${message.received_date}
- **Thread**: ${message.thread_id ? 'Part of thread' : 'Initial message'}

## Email Body
${message.body}

## Instructions
1. **Summary**: Provide a concise 2-3 sentence summary
2. **Intent**: Identify the primary intent/purpose
3. **Urgency**: Score 0-10 based on time sensitivity
4. **Signal Score**: Score 0-100 based on value vs noise
5. **Importance**: Score 0-100 based on actionability
6. **Tasks**: Extract any actionable items
7. **Entities**: Identify people, companies, dates, amounts, etc.
8. **Project**: If this relates to an ongoing project, suggest a name
9. **Keywords**: Extract 3-10 relevant keywords

Focus on accuracy and consistency. Be thorough but concise.
`;
}
```

### Class Structure

```typescript
export class ExtractionWorker {
  private supabase: SupabaseClient;
  private isRunning = false;
  private readonly MAX_RETRIES = 3;
  private readonly POLL_INTERVAL_MS = 5000; // 5 seconds
  private readonly PROCESSING_TIMEOUT_MS = 30000; // 30 seconds
  
  constructor();
  
  // Lifecycle methods
  async start(): Promise<void>;
  async stop(): Promise<void>;
  
  // Core processing
  private async runWorker(): Promise<void>;
  private async processQueueJob(job: ExtractionJob): Promise<void>;
  
  // LLM methods
  private async extractWithLLM(message: EmailMessage): Promise<UniversalExtraction>;
  private formatExtractionPrompt(message: EmailMessage): string;
  
  // Storage methods
  private async saveExtraction(messageId: string, extraction: UniversalExtraction): Promise<void>;
  private async saveEntities(extractionId: string, entities: Entity[]): Promise<void>;
  private async updateOrCreateProject(extraction: UniversalExtraction): Promise<string | null>;
  
  // Queue management
  private async markProcessing(queueId: string): Promise<void>;
  private async markCompleted(queueId: string): Promise<void>;
  private async markFailed(queueId: string, error: string): Promise<void>;
  
  // Helper methods
  private delay(ms: number): Promise<void>;
}
```

### Configuration

```typescript
// In src/config.ts
extraction: {
  enabled: boolean;              // Enable/disable extraction worker
  pollIntervalMs: number;        // Polling interval (default: 5000)
  maxRetries: number;            // Max retry attempts (default: 3)
  timeoutMs: number;             // Processing timeout (default: 30000)
  llmProvider: string;           // 'openai' | 'anthropic' (default: 'openai')
  llmModel: string;              // Model name (default: 'gpt-4o')
  temperature: number;           // LLM temperature (default: 0.1)
}
```

### Environment Variables

```env
# Extraction Worker
EXTRACTION_ENABLED=true
EXTRACTION_POLL_INTERVAL_MS=5000
EXTRACTION_MAX_RETRIES=3
EXTRACTION_TIMEOUT_MS=30000
EXTRACTION_LLM_PROVIDER=openai
EXTRACTION_LLM_MODEL=gpt-4o
EXTRACTION_LLM_TEMPERATURE=0.1

# OpenAI Configuration
OPENAI_API_KEY=sk-...

# Optional: Anthropic Configuration
ANTHROPIC_API_KEY=sk-ant-...
```

### Error Handling

```typescript
interface RetryStrategy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  strategy: RetryStrategy,
  attempt = 1
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (attempt >= strategy.maxRetries) {
      throw error;
    }
    
    // Exponential backoff: 1s, 2s, 4s, 8s, etc.
    const delayMs = Math.min(
      strategy.baseDelayMs * Math.pow(2, attempt - 1),
      strategy.maxDelayMs
    );
    
    console.log(`Retry attempt ${attempt + 1} after ${delayMs}ms`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    return retryWithBackoff(fn, strategy, attempt + 1);
  }
}
```

### Statistics Logged
- Queue depth (messages waiting)
- Processing rate (messages/minute)
- Success rate (%)
- Average processing time
- Token usage (prompt + completion)
- Retry rate (%)
- Error types and frequency
- Priority distribution of processed messages

---

## Database Schema Requirements

### Table: email_extraction_queue

This table tracks the extraction queue. Unlike PGMQ, this is a simple database table for tracking.

```sql
CREATE TABLE email_extraction_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES support_email_messages(id) ON DELETE CASCADE,
  inbox_id UUID NOT NULL REFERENCES support_inboxes(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  
  -- Queue management
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'retrying')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  
  -- Timestamps
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processing_completed_at TIMESTAMPTZ,
  
  -- Retry logic
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  
  -- Metadata
  processing_time_ms INTEGER,
  token_count INTEGER,
  
  -- Indexes
  UNIQUE(message_id), -- Prevent duplicate queueing
  INDEX idx_extraction_queue_status_priority ON email_extraction_queue(status, priority DESC, queued_at ASC),
  INDEX idx_extraction_queue_tenant ON email_extraction_queue(tenant_id)
);
```

### Table: email_extractions

Main results table (already defined in architecture doc - no changes needed).

### Table: email_extraction_entities

Normalized entity storage (already defined in architecture doc - no changes needed).

### Table: email_projects

Project grouping metadata (already defined in architecture doc - no changes needed).

---

## Implementation Steps

### Phase 1: ExtractionQueueProcessor (Worker 1)

1. ✅ Create `src/extraction-queue-processor.ts`
2. ✅ Implement priority calculation algorithm
3. ✅ Implement discovery query
4. ✅ Implement deduplication logic
5. ✅ Add batch processing loop
6. ✅ Add comprehensive logging
7. ✅ Update `src/config.ts` with queue config
8. ✅ Update `src/index.ts` to start worker
9. ✅ Test with sample unprocessed messages

### Phase 2: Database Migration

1. ✅ Create migration `005_create_email_extraction_queue.sql`
2. ✅ Define `email_extraction_queue` table
3. ✅ Define `email_extractions` table (from architecture)
4. ✅ Define `email_extraction_entities` table (from architecture)
5. ✅ Define `email_projects` table (from architecture)
6. ✅ Add indexes for performance
7. ✅ Run migration on development database

### Phase 3: ExtractionWorker (Worker 2)

1. ✅ Install AI SDK dependencies
   ```bash
   npm install ai @ai-sdk/openai @ai-sdk/anthropic zod
   ```

2. ✅ Create `src/extraction-worker.ts`
3. ✅ Define Universal Extraction Schema (Zod)
4. ✅ Implement LLM integration (Vercel AI SDK)
5. ✅ Implement prompt formatting
6. ✅ Implement result storage
7. ✅ Implement entity extraction storage
8. ✅ Implement project detection/creation
9. ✅ Add retry logic with exponential backoff
10. ✅ Add comprehensive error handling
11. ✅ Update `src/config.ts` with extraction config
12. ✅ Update `src/index.ts` to start worker
13. ✅ Test end-to-end extraction pipeline

### Phase 4: Testing & Validation

1. ✅ Test queue processor finds unprocessed messages
2. ✅ Test priority calculation is correct
3. ✅ Test deduplication prevents duplicates
4. ✅ Test extraction worker pulls from queue
5. ✅ Test LLM extraction produces valid results
6. ✅ Test results are saved correctly
7. ✅ Test retry logic on failures
8. ✅ Test both workers running simultaneously
9. ✅ Monitor performance and token usage

### Phase 5: Production Deployment

1. ✅ Review and optimize configuration
2. ✅ Set up monitoring/alerting
3. ✅ Deploy database migration
4. ✅ Deploy updated service with both workers
5. ✅ Monitor queue depth and processing rate
6. ✅ Monitor token usage and costs
7. ✅ Fine-tune priority algorithm based on usage
8. ✅ Optimize batch sizes and polling intervals

---

## Integration with Existing Workers

The service will now run **6 workers** simultaneously:

1. **QueueProcessor** - Real-time webhook notifications
2. **BackfillProcessor** - Orchestrates thread discovery
3. **ThreadSyncProcessor** - Syncs individual threads
4. **CompletionMonitor** - Tracks progress & marks complete
5. **ExtractionQueueProcessor** - Queues unprocessed messages *(NEW)*
6. **ExtractionWorker** - Processes queue with LLM *(NEW)*

### Updated `src/index.ts`

```typescript
async function main() {
  // ... existing code ...
  
  // Create all six processors
  webhookProcessor = new QueueProcessor();
  backfillProcessor = new BackfillProcessor();
  threadSyncProcessor = new ThreadSyncProcessor();
  completionMonitor = new CompletionMonitor();
  extractionQueueProcessor = new ExtractionQueueProcessor(); // NEW
  extractionWorker = new ExtractionWorker(); // NEW
  
  // Start all six processors in parallel
  await Promise.all([
    webhookProcessor.start(),
    backfillProcessor.start(),
    threadSyncProcessor.start(),
    completionMonitor.start(),
    extractionQueueProcessor.start(), // NEW
    extractionWorker.start(), // NEW
  ]);
  
  console.log('[Service] All six processors are running');
}
```

---

## Performance Considerations

### Batch Sizes
- **Queue Processor**: 10 messages per batch (can be increased if needed)
- **Extraction Worker**: 1 message at a time (LLM processing is slow)

### Polling Intervals
- **Queue Processor**: 15 seconds (can poll more frequently)
- **Extraction Worker**: 5 seconds (should be frequent to minimize latency)

### Rate Limiting
- **LLM API**: Implement exponential backoff on rate limit errors
- **Database**: Use connection pooling to avoid exhaustion

### Cost Optimization
- Monitor token usage per message
- Consider using cheaper models for low-priority messages
- Implement token usage budgets per tenant

### Scaling
- Both workers can be horizontally scaled
- Use database-level locking to prevent duplicate processing
- Consider PGMQ for true distributed queue in future

---

## Monitoring & Observability

### Key Metrics

**Queue Processor Metrics:**
- Messages discovered per poll
- Messages queued per hour
- Queue depth (messages waiting)
- Deduplication hits (skipped messages)
- Error rate

**Extraction Worker Metrics:**
- Processing rate (messages/minute)
- Average processing time
- Token usage (prompt + completion)
- Success rate (%)
- Retry rate (%)
- Queue depth
- Priority distribution

### Health Checks

```sql
-- Check queue processor health
SELECT 
  COUNT(*) FILTER (WHERE status = 'queued') as queued,
  COUNT(*) FILTER (WHERE status = 'processing') as processing,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  AVG(EXTRACT(EPOCH FROM (NOW() - queued_at))) FILTER (WHERE status = 'queued') as avg_wait_seconds
FROM email_extraction_queue;

-- Check extraction worker performance
SELECT
  DATE_TRUNC('hour', processing_completed_at) as hour,
  COUNT(*) as completed,
  AVG(processing_time_ms) as avg_ms,
  SUM(token_count) as total_tokens,
  AVG(retry_count) as avg_retries
FROM email_extraction_queue
WHERE status = 'completed'
  AND processing_completed_at > NOW() - INTERVAL '24 hours'
GROUP BY hour
ORDER BY hour DESC;
```

---

## Future Enhancements

### Phase 6 (Future)
- [ ] Implement domain plugins (landlord, sales, IT support, etc.)
- [ ] Implement role plugins (property manager, sales rep, etc.)
- [ ] Add project clustering with embeddings (pgvector)
- [ ] Implement semantic search on extractions
- [ ] Add multi-language support
- [ ] Implement custom extraction rules per tenant
- [ ] Add real-time streaming LLM APIs
- [ ] Implement automated response suggestions

### Phase 7 (Experimental)
- [ ] Multi-modal extraction (attachments, images)
- [ ] Audio transcription and extraction
- [ ] Video content analysis
- [ ] Sentiment trend analysis over time
- [ ] Smart reply generation

---

## Version History

- **v1.0.0** (2025-12-01): Initial plan for extraction workers

---

**Status**: Ready for Implementation  
**Next Step**: Create ExtractionQueueProcessor (Phase 1)
