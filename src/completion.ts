import { config, validateConfig } from './config';
import { CompletionMonitor } from './completion-monitor';

let monitor: CompletionMonitor | null = null;
let isShuttingDown = false;

async function main() {
  try {
    console.log('[Completion] Starting Completion Monitor...');
    
    // Validate configuration
    validateConfig();
    
    // Create and start completion monitor
    monitor = new CompletionMonitor();
    await monitor.start();
    
    console.log('[Completion] Completion Monitor started successfully');
    console.log('[Completion] Monitoring backfill progress and completion');
    
  } catch (error) {
    console.error('[Completion] Failed to start:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Completion] Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[Completion] Received ${signal}, shutting down gracefully...`);
  
  if (monitor) {
    await monitor.stop();
  }
  
  console.log('[Completion] Shutdown complete');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Completion] Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Completion] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the service
main();
