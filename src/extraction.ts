import { config, validateConfig } from './config';
import { ExtractionWorker } from './extraction-worker';

let processor: ExtractionWorker | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Extraction] Starting Extraction Worker...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start extraction worker
    processor = new ExtractionWorker();
    await processor.start();
    
    console.log('[Extraction] Extraction Worker started successfully');
    console.log('[Extraction] Processing queued messages with LLM');
    
  } catch (error) {
    console.error('[Extraction] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Extraction] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Extraction] Received ${signal}, shutting down gracefully...`);
  
  if (processor) {
    await processor.stop();
  }
  
  console.log('[Extraction] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Extraction] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Extraction] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
