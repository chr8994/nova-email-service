import { config, validateConfig } from './config';
import { QueueProcessor } from './queue-processor';
import { BackfillProcessor } from './backfill-processor';
import { ThreadSyncProcessor } from './thread-sync-processor';

let webhookProcessor: QueueProcessor | null = null;
let backfillProcessor: BackfillProcessor | null = null;
let threadSyncProcessor: ThreadSyncProcessor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Service] Starting Nova Email Service...');
    
    // Validate configuration
    validateConfig();
    
    // Create all three processors
    webhookProcessor = new QueueProcessor();
    backfillProcessor = new BackfillProcessor();
    threadSyncProcessor = new ThreadSyncProcessor();
    
    // Start all three processors in parallel
    console.log('[Service] Starting webhook, backfill, and thread sync processors...');
    await Promise.all([
      webhookProcessor.start(),
      backfillProcessor.start(),
      threadSyncProcessor.start()
    ]);
    
    console.log('[Service] Nova Email Service started successfully');
    console.log('[Service] All three processors are running:');
    console.log('[Service] - Webhook processor (real-time notifications)');
    console.log('[Service] - Backfill processor (orchestrates thread discovery)');
    console.log('[Service] - Thread sync processor (syncs individual threads)');
    
  } catch (error) {
    console.error('[Service] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Service] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Service] Received ${signal}, shutting down gracefully...`);
  
  // Stop all three processors in parallel
  const shutdownPromises = [];
  
  if (webhookProcessor) {
    shutdownPromises.push(webhookProcessor.stop());
  }
  
  if (backfillProcessor) {
    shutdownPromises.push(backfillProcessor.stop());
  }
  
  if (threadSyncProcessor) {
    shutdownPromises.push(threadSyncProcessor.stop());
  }
  
  await Promise.all(shutdownPromises);
  
  console.log('[Service] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Service] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Service] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
