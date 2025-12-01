import { config, validateConfig } from './config';
import { QueueProcessor } from './queue-processor';

let processor: QueueProcessor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Webhooks] Starting Webhook Processor...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start webhook processor
    processor = new QueueProcessor();
    await processor.start();
    
    console.log('[Webhooks] Webhook Processor started successfully');
    console.log('[Webhooks] Processing real-time Nylas webhook notifications');
    
  } catch (error) {
    console.error('[Webhooks] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Webhooks] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Webhooks] Received ${signal}, shutting down gracefully...`);
  
  if (processor) {
    await processor.stop();
  }
  
  console.log('[Webhooks] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Webhooks] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Webhooks] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
