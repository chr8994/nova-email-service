import { config, validateConfig } from './config';
import { BackfillProcessor } from './backfill-processor';

let processor: BackfillProcessor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Backfill] Starting Backfill Processor...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start backfill processor
    processor = new BackfillProcessor();
    await processor.start();
    
    console.log('[Backfill] Backfill Processor started successfully');
    console.log('[Backfill] Orchestrating historical thread discovery');
    
  } catch (error) {
    console.error('[Backfill] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Backfill] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Backfill] Received ${signal}, shutting down gracefully...`);
  
  if (processor) {
    await processor.stop();
  }
  
  console.log('[Backfill] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Backfill] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Backfill] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
