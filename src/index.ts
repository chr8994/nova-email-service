import { config, validateConfig } from './config';
import { QueueProcessor } from './queue-processor';
import { BackfillProcessor } from './backfill-processor';
import { ThreadSyncProcessor } from './thread-sync-processor';
import { CompletionMonitor } from './completion-monitor';

let webhookProcessor: QueueProcessor | null = null;
let backfillProcessor: BackfillProcessor | null = null;
let threadSyncProcessor: ThreadSyncProcessor | null = null;
let completionMonitor: CompletionMonitor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Service] Starting Nova Email Service...');
    
    // Validate configuration
    validateConfig();
    
    // Create all four processors
    webhookProcessor = new QueueProcessor();
    backfillProcessor = new BackfillProcessor();
    threadSyncProcessor = new ThreadSyncProcessor();
    completionMonitor = new CompletionMonitor();
    
    // Start all four processors in parallel
    console.log('[Service] Starting webhook, backfill, thread sync, and completion monitor processors...');
    await Promise.all([
      webhookProcessor.start(),
      backfillProcessor.start(),
      threadSyncProcessor.start(),
      completionMonitor.start()
    ]);
    
    console.log('[Service] Nova Email Service started successfully');
    console.log('[Service] All four processors are running:');
    console.log('[Service] - Webhook processor (real-time notifications)');
    console.log('[Service] - Backfill processor (orchestrates thread discovery)');
    console.log('[Service] - Thread sync processor (syncs individual threads)');
    console.log('[Service] - Completion monitor (tracks progress & marks complete)');
    
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
  
  // Stop all four processors in parallel
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
  
  if (completionMonitor) {
    shutdownPromises.push(completionMonitor.stop());
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
