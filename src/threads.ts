import { config, validateConfig } from './config';
import { ThreadSyncProcessor } from './thread-sync-processor';

let processor: ThreadSyncProcessor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Threads] Starting Thread Sync Processor...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start thread sync processor
    processor = new ThreadSyncProcessor();
    await processor.start();
    
    console.log('[Threads] Thread Sync Processor started successfully');
    console.log('[Threads] Syncing individual thread messages');
    
  } catch (error) {
    console.error('[Threads] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Threads] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Threads] Received ${signal}, shutting down gracefully...`);
  
  if (processor) {
    await processor.stop();
  }
  
  console.log('[Threads] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Threads] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Threads] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
