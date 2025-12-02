import { config, validateConfig } from './config';
import { ExtractionQueueProcessor } from './extraction-queue-processor';

let processor: ExtractionQueueProcessor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[ExtractionQueue] Starting Extraction Queue Processor...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start extraction queue processor
    processor = new ExtractionQueueProcessor();
    await processor.start();
    
    console.log('[ExtractionQueue] Extraction Queue Processor started successfully');
    console.log('[ExtractionQueue] Queuing unprocessed messages for AI extraction');
    
  } catch (error) {
    console.error('[ExtractionQueue] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[ExtractionQueue] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[ExtractionQueue] Received ${signal}, shutting down gracefully...`);
  
  if (processor) {
    await processor.stop();
  }
  
  console.log('[ExtractionQueue] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[ExtractionQueue] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ExtractionQueue] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
