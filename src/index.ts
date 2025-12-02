import { config, validateConfig } from './config';
import { QueueProcessor } from './queue-processor';
import { BackfillProcessor } from './backfill-processor';
import { ThreadSyncProcessor } from './thread-sync-processor';
import { CompletionMonitor } from './completion-monitor';
import { ExtractionQueueProcessor } from './extraction-queue-processor';
import { ExtractionWorker } from './extraction-worker';

let webhookProcessor: QueueProcessor | null = null;
let backfillProcessor: BackfillProcessor | null = null;
let threadSyncProcessor: ThreadSyncProcessor | null = null;
let completionMonitor: CompletionMonitor | null = null;
let extractionQueueProcessor: ExtractionQueueProcessor | null = null;
let extractionWorker: ExtractionWorker | null = null;
let isShuttingDown = false;

async function main() {
  try {
    const workerType = process.env.WORKER_TYPE || 'all';
    console.log(`[Service] Starting Nova Email Service (worker type: ${workerType})...`);
    
    // Validate configuration
    validateConfig();
    
    // Start processor(s) based on WORKER_TYPE env var
    switch (workerType) {
      case 'webhooks':
        console.log('[Service] Starting webhook processor...');
        webhookProcessor = new QueueProcessor();
        await webhookProcessor.start();
        console.log('[Service] Webhook processor started (real-time notifications)');
        break;
        
      case 'backfill':
        console.log('[Service] Starting backfill processor...');
        backfillProcessor = new BackfillProcessor();
        await backfillProcessor.start();
        console.log('[Service] Backfill processor started (orchestrates thread discovery)');
        break;
        
      case 'threads':
        console.log('[Service] Starting thread sync processor...');
        threadSyncProcessor = new ThreadSyncProcessor();
        await threadSyncProcessor.start();
        console.log('[Service] Thread sync processor started (syncs individual threads)');
        break;
        
      case 'completion':
        console.log('[Service] Starting completion monitor...');
        completionMonitor = new CompletionMonitor();
        await completionMonitor.start();
        console.log('[Service] Completion monitor started (tracks progress & marks complete)');
        break;
        
      case 'extraction-queue':
        console.log('[Service] Starting extraction queue processor...');
        extractionQueueProcessor = new ExtractionQueueProcessor();
        await extractionQueueProcessor.start();
        console.log('[Service] Extraction queue processor started (queues messages for AI extraction)');
        break;
        
      case 'extraction':
        console.log('[Service] Starting extraction worker...');
        extractionWorker = new ExtractionWorker();
        await extractionWorker.start();
        console.log('[Service] Extraction worker started (processes queue with LLM)');
        break;
        
      case 'all':
      default:
        // Run all six processors (default behavior for development)
        console.log('[Service] Starting all processors...');
        webhookProcessor = new QueueProcessor();
        backfillProcessor = new BackfillProcessor();
        threadSyncProcessor = new ThreadSyncProcessor();
        completionMonitor = new CompletionMonitor();
        extractionQueueProcessor = new ExtractionQueueProcessor();
        extractionWorker = new ExtractionWorker();
        
        await Promise.all([
          webhookProcessor.start(),
          backfillProcessor.start(),
          threadSyncProcessor.start(),
          completionMonitor.start(),
          extractionQueueProcessor.start(),
          extractionWorker.start()
        ]);
        
        console.log('[Service] Nova Email Service started successfully');
        console.log('[Service] All six processors are running:');
        console.log('[Service] - Webhook processor (real-time notifications)');
        console.log('[Service] - Backfill processor (orchestrates thread discovery)');
        console.log('[Service] - Thread sync processor (syncs individual threads)');
        console.log('[Service] - Completion monitor (tracks progress & marks complete)');
        console.log('[Service] - Extraction queue processor (queues messages for AI extraction)');
        console.log('[Service] - Extraction worker (processes queue with LLM)');
        break;
    }
    
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
  
  // Stop all six processors in parallel
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
  
  if (extractionQueueProcessor) {
    shutdownPromises.push(extractionQueueProcessor.stop());
  }
  
  if (extractionWorker) {
    shutdownPromises.push(extractionWorker.stop());
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
