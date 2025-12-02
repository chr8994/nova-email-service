import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
  },
  nylas: {
    apiKey: process.env.NYLAS_API_KEY || '',
    apiUri: process.env.NYLAS_API_URI || 'https://api.us.nylas.com',
  },
  queue: {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
    visibilityTimeout: parseInt(process.env.VISIBILITY_TIMEOUT || '300', 10),
  },
  processing: {
    // Delay between processing threads (ms)
    threadDelayMs: parseInt(process.env.THREAD_DELAY_MS || '3000', 10),
    // Delay between processing individual messages (ms)
    messageDelayMs: parseInt(process.env.MESSAGE_DELAY_MS || '1000', 10),
    // Delay between API calls to prevent rate limiting (ms)
    apiDelayMs: parseInt(process.env.API_DELAY_MS || '200', 10),
  },
  extractionQueue: {
    enabled: process.env.EXTRACTION_QUEUE_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.EXTRACTION_QUEUE_POLL_INTERVAL_MS || '15000', 10),
    batchSize: parseInt(process.env.EXTRACTION_QUEUE_BATCH_SIZE || '10', 10),
  },
  extraction: {
    enabled: process.env.EXTRACTION_ENABLED !== 'false',
    pollIntervalMs: parseInt(process.env.EXTRACTION_POLL_INTERVAL_MS || '5000', 10),
    maxRetries: parseInt(process.env.EXTRACTION_MAX_RETRIES || '3', 10),
    timeoutMs: parseInt(process.env.EXTRACTION_TIMEOUT_MS || '30000', 10),
    llmProvider: process.env.EXTRACTION_LLM_PROVIDER || 'openai',
    llmModel: process.env.EXTRACTION_LLM_MODEL || 'gpt-4.1',
    temperature: parseFloat(process.env.EXTRACTION_LLM_TEMPERATURE || '0.1'),
  },
  spamDetection: {
    enabled: process.env.SPAM_DETECTION_ENABLED !== 'false',
    model: process.env.SPAM_DETECTION_MODEL || 'gpt-4o-mini',
    batchSize: parseInt(process.env.SPAM_DETECTION_BATCH_SIZE || '10', 10),
  },
  pgmq: {
    enabled: process.env.EXTRACTION_PGMQ_ENABLED !== 'false',
    visibilityTimeout: parseInt(process.env.EXTRACTION_PGMQ_VISIBILITY_TIMEOUT || '300', 10),
    batchSize: parseInt(process.env.EXTRACTION_PGMQ_BATCH_SIZE || '5', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  testingMode: process.env.TESTING_MODE === 'true',
};

export function validateConfig(): void {
  const required = [
    ['SUPABASE_URL', config.supabase.url],
    ['SUPABASE_SERVICE_KEY', config.supabase.serviceKey],
    ['NYLAS_API_KEY', config.nylas.apiKey],
  ] as const;

  const missing = required.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please copy .env.example to .env and fill in the values.'
    );
  }

  console.log('[Config] Configuration validated successfully');
}
