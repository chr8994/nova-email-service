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
