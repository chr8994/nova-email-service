import { z } from 'zod';

/**
 * Spam Detection Schema
 * 
 * Minimal LLM output structure for classifying emails as spam or promotional.
 * This is used before queueing threads for full extraction to save API costs.
 */

export const SpamDetectionSchema = z.object({
  is_spam: z.boolean()
    .describe('True if email is spam, unsolicited, phishing, or scam'),
  
  is_promotional: z.boolean()
    .describe('True if email is promotional, marketing, newsletter, or bulk/sales email'),
  
  confidence: z.number()
    .min(0)
    .max(1)
    .describe('Confidence score 0.0-1.0 for this classification'),
  
  reasoning: z.string()
    .max(200)
    .describe('Brief 1-sentence explanation for the classification')
});

export type SpamDetection = z.infer<typeof SpamDetectionSchema>;

/**
 * Example LLM prompt for spam detection:
 * 
 * ```
 * Analyze this email thread and classify if it's spam or promotional.
 * 
 * Thread Subject: {subject}
 * From: {from_name} <{from_email}>
 * Preview: {first_200_chars}
 * 
 * DEFINITIONS:
 * - spam: unsolicited, phishing attempts, scams, suspicious senders
 * - promotional: marketing emails, newsletters, sales pitches, bulk campaigns
 * 
 * Return JSON with: is_spam (boolean), is_promotional (boolean), confidence (0-1), reasoning (1 sentence)
 * ```
 */
