import { z } from 'zod';

// Intent classification
export const IntentSchema = z.enum([
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
  'promotion',
  'notification',
  'alert'
]);

// Message classification
export const MessageClassSchema = z.enum([
  'transactional_notification',
  'vendor_marketing',
  'system_alert',
  'newsletter',
  'conversational_email',
  'automated_promo'
]);

// Sender type
export const SenderTypeSchema = z.enum([
  'person',
  'company',
  'automated_system',
  'marketing_platform'
]);

// Category
export const CategorySchema = z.enum([
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
  'customer_support',
  'newsletter'
]);

// Entity type
export const EntityTypeSchema = z.enum([
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

// Entity schema
export const EntitySchema = z.object({
  entity_type: EntityTypeSchema.default('other'),
  entity_value: z.string(),
  entity_context: z.string().default('').describe('Context or additional information about the entity'),
  confidence: z.enum(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']).default('5').describe('Confidence score 1-10: 1-3 low, 4-6 medium, 7-10 high')
});

// Main Universal Extraction Schema
export const UniversalExtractionSchema = z.object({
  // Core fields
  summary: z.string().describe('Brief summary of the email (2-3 sentences)'),
  intent: IntentSchema.describe('Primary intent of the message'),
  urgency: z.number().min(0).max(10).describe('Urgency score (0-10, 10 is most urgent)'),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']).describe('Overall sentiment'),
  needs_reply: z.boolean().default(false).describe('Does this message require a response?'),
  actionability: z.enum(['none', 'low', 'medium', 'high', 'critical']).describe('Level of actionability/urgency for recipient'),
  reply_expectation: z.enum(['none', 'optional', 'expected', 'required']).describe('Whether a reply is expected'),
  
  // Scoring
  signal_score: z.number().min(0).max(100).describe('Signal-to-noise ratio (0-100)'),
  importance_score: z.number().min(0).max(100).describe('User-specific importance (0-100)'),
  
  // Classification
  message_class: MessageClassSchema.default('conversational_email').describe('Type of message'),
  sender_type: SenderTypeSchema.describe('Type of sender'),
  category: CategorySchema.default('conversation').describe('Content category'),
  
  // Text analysis
  tone: z.enum(['formal', 'casual', 'urgent', 'friendly', 'professional', 'other']).describe('Tone of message'),
  language: z.string().default('en').describe('Detected language code (e.g., "en", "es")'),
  task_likelihood: z.number().min(0).max(10).describe('Likelihood this contains actionable tasks (0-10)'),
  
  // Arrays
  tasks: z.array(z.string()).describe('List of actionable tasks mentioned'),
  risks: z.array(z.string()).describe('Potential risks or concerns identified'),
  topic_keywords: z.array(z.string()).describe('Key topics/keywords (3-10 words)'),
  external_links: z.array(z.string()).describe('External URLs mentioned'),
  
  // Entities
  entities: z.array(EntitySchema).describe('Named entities extracted from the message'),
  
  // Project detection
  project_label: z.string().default('').describe('Human-readable project name if detected'),
  project_confidence: z.number().min(0).max(1).default(0).describe('Confidence in project match (0-1)'),
  
  // Metrics
  reading_time_seconds: z.number().describe('Estimated reading time in seconds'),
  
  // Conversation context
  is_reply: z.boolean().describe('Is this a reply to another message?'),
  is_forward: z.boolean().describe('Is this a forwarded message?'),
  message_type: z.enum(['initial', 'reply', 'forward', 'automated']).describe('Type of message in conversation'),

  // Thread-level fields
  thread_summary: z.string().default('').describe('Summary of the entire conversation'),
  participants: z.array(z.object({
    name: z.string().default(''),
    email: z.string(),
    role: z.string().default('')
  })).default([]).describe('List of all participants in the thread')
});

export type UniversalExtraction = z.infer<typeof UniversalExtractionSchema>;
export type Entity = z.infer<typeof EntitySchema>;
