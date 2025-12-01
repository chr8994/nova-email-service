import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

interface ThreadStats {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  messages_synced: number;
}

interface ActiveConfig {
  id: string;
  inbox_id: string;
  backfill_status: string;
  backfill_started_at: string | null;
}

export class CompletionMonitor {
  private supabase: SupabaseClient;
  private isRunning = false;
  private readonly CHECK_INTERVAL_MS = parseInt(
    process.env.COMPLETION_CHECK_INTERVAL_MS || '5000',
    10
  );
  private readonly ENABLE_AUTO_RECOVERY = process.env.ENABLE_AUTO_RECOVERY !== 'false'; // Default: true
  private readonly RECOVERY_CHECK_INTERVAL_MS = parseInt(
    process.env.RECOVERY_CHECK_INTERVAL_MS || '60000',
    10
  );
  private lastRecoveryCheck = 0;
  
  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[Monitor] Already running');
      return;
    }
    
    this.isRunning = true;
    console.log('[Monitor] Starting completion monitor');
    console.log(`[Monitor] Checking for completion every ${this.CHECK_INTERVAL_MS}ms`);
    
    // Start continuous monitoring loop
    await this.runWorker();
  }
  
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    console.log('[Monitor] Stopping completion monitor');
    this.isRunning = false;
    console.log('[Monitor] Stopped');
  }
  
  private async runWorker(): Promise<void> {
    console.log('[Monitor] Completion monitor started. Monitoring backfill progress...');
    if (this.ENABLE_AUTO_RECOVERY) {
      console.log(`[Monitor] Auto-recovery enabled. Checking for premature completions every ${this.RECOVERY_CHECK_INTERVAL_MS}ms`);
    }
    
    // Continuously monitor active backfills
    while (this.isRunning) {
      try {
        // Periodic recovery check for prematurely completed backfills
        if (this.ENABLE_AUTO_RECOVERY) {
          const now = Date.now();
          if (now - this.lastRecoveryCheck >= this.RECOVERY_CHECK_INTERVAL_MS) {
            await this.checkForPrematureCompletions();
            this.lastRecoveryCheck = now;
          }
        }
        
        // Get all active backfills (not completed or failed)
        const activeConfigs = await this.getActiveBackfills();
        
        if (activeConfigs.length === 0) {
          // No active backfills to monitor
          await this.delay(this.CHECK_INTERVAL_MS);
          continue;
        }
        
        console.log(`[Monitor] Monitoring ${activeConfigs.length} active backfill(s)`);
        
        // Process each active backfill
        for (const configData of activeConfigs) {
          await this.monitorConfig(configData);
        }
        
        // Wait before next check
        await this.delay(this.CHECK_INTERVAL_MS);
        
      } catch (error) {
        console.error('[Monitor] Worker error:', error);
        await this.delay(5000);
      }
    }
  }
  
  private async getActiveBackfills(): Promise<ActiveConfig[]> {
    try {
      const { data, error } = await this.supabase
        .from('support_inbox_configurations')
        .select('id, inbox_id, backfill_status, backfill_started_at')
        .in('backfill_status', ['backfill', 'thread_sync', 'in_progress']);
      
      if (error) {
        console.error('[Monitor] Error fetching active backfills:', error);
        return [];
      }
      
      return (data || []) as ActiveConfig[];
    } catch (error) {
      console.error('[Monitor] Error in getActiveBackfills:', error);
      return [];
    }
  }
  
  private async monitorConfig(configData: ActiveConfig): Promise<void> {
    try {
      const { id: configId, backfill_status } = configData;
      
      // Get current thread statistics
      const stats = await this.getThreadStats(configId);
      
      // Calculate progress
      const progressPercentage = stats.total > 0
        ? Math.round(((stats.completed + stats.failed) / stats.total) * 100)
        : 0;
      
      // Log progress
      console.log(`[Monitor] Config ${configId.substring(0, 8)}... | Status: ${backfill_status} | Progress: ${progressPercentage}% (${stats.completed + stats.failed}/${stats.total}) | Processing: ${stats.processing} | Failed: ${stats.failed} | Messages: ${stats.messages_synced}`);
      
      // Update progress stats
      await this.updateProgressStats(configId, stats);
      
      // Check if backfill is complete
      if (stats.total > 0 && (stats.completed + stats.failed) >= stats.total) {
        // Double-check: verify no threads are still queued or processing
        if (stats.queued > 0 || stats.processing > 0) {
          console.log(`[Monitor] ⏸️  Delaying completion for ${configId.substring(0, 8)}... - ${stats.queued + stats.processing} threads still active`);
          return;
        }
        
        console.log(`[Monitor] 🎉 Backfill ${configId.substring(0, 8)}... is COMPLETE!`);
        console.log(`[Monitor] Summary: ${stats.completed} completed, ${stats.failed} failed, ${stats.messages_synced} messages synced`);
        await this.markBackfillComplete(configId, stats);
      }
      
    } catch (error) {
      console.error(`[Monitor] Error monitoring config ${configData.id}:`, error);
    }
  }
  
  private async getThreadStats(configId: string): Promise<ThreadStats> {
    try {
      // Use RPC to calculate stats server-side (avoids 1000 row limit)
      const { data, error } = await this.supabase
        .rpc('get_backfill_stats', { p_config_id: configId });
      
      if (error) {
        console.error(`[Monitor] Error fetching stats for config ${configId}:`, error);
        return this.emptyStats();
      }
      
      if (!data || data.length === 0) {
        return this.emptyStats();
      }
      
      const result = data[0];
      
      // Safely convert BigInts (returned as numbers or strings) to number
      return {
        total: Number(result.total || 0),
        queued: Number(result.queued || 0),
        processing: Number(result.processing || 0),
        completed: Number(result.completed || 0),
        failed: Number(result.failed || 0),
        messages_synced: Number(result.messages_synced || 0),
      };
      
    } catch (error) {
      console.error('[Monitor] Error in getThreadStats:', error);
      return this.emptyStats();
    }
  }
  
  private emptyStats(): ThreadStats {
    return {
      total: 0,
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      messages_synced: 0,
    };
  }
  
  private async updateProgressStats(configId: string, stats: ThreadStats): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('inbox_sync_stats')
        .update({
          threads_total: stats.total,
          threads_queued: stats.queued,
          threads_processing: stats.processing,
          threads_completed: stats.completed,
          threads_failed: stats.failed,
          messages_synced: stats.messages_synced,
          last_thread_at: new Date().toISOString(),
        })
        .eq('config_id', configId);
      
      if (error) {
        console.error(`[Monitor] Error updating stats for config ${configId}:`, error);
      }
    } catch (error) {
      console.error('[Monitor] Error in updateProgressStats:', error);
    }
  }
  
  private async markBackfillComplete(configId: string, stats: ThreadStats): Promise<void> {
    try {
      const now = new Date().toISOString();
      
      // Update configuration status
      const { error: configError } = await this.supabase
        .from('support_inbox_configurations')
        .update({
          backfill_status: 'completed',
          backfill_completed_at: now,
          updated_at: now,
        })
        .eq('id', configId);
      
      if (configError) {
        console.error(`[Monitor] Error updating config status for ${configId}:`, configError);
      }
      
      // Update sync stats with completion timestamp
      const { error: statsError } = await this.supabase
        .from('inbox_sync_stats')
        .update({
          sync_completed_at: now,
          threads_completed: stats.completed,
          threads_failed: stats.failed,
          messages_synced: stats.messages_synced,
        })
        .eq('config_id', configId);
      
      if (statsError) {
        console.error(`[Monitor] Error updating sync stats for ${configId}:`, statsError);
      }
      
      console.log(`[Monitor] ✅ Marked backfill ${configId.substring(0, 8)}... as completed`);
      console.log(`[Monitor] Final stats: ${stats.completed} threads completed, ${stats.failed} failed, ${stats.messages_synced} messages synced`);
      
    } catch (error) {
      console.error('[Monitor] Error in markBackfillComplete:', error);
    }
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  private async checkForPrematureCompletions(): Promise<void> {
    try {
      const completedConfigs = await this.getCompletedBackfills();
      
      if (completedConfigs.length === 0) {
        return;
      }
      
      console.log(`[Monitor] 🔍 Scanning ${completedConfigs.length} completed backfill(s) for premature completion...`);
      
      for (const configData of completedConfigs) {
        const stats = await this.getThreadStats(configData.id);
        
        // Check if there are still threads to process
        const pendingThreads = stats.queued + stats.processing;
        if (pendingThreads > 0) {
          console.log(`[Monitor] ⚠️  Found prematurely completed backfill: ${configData.id.substring(0, 8)}...`);
          console.log(`[Monitor] 📊 Incomplete work: ${stats.queued} queued, ${stats.processing} processing (${stats.completed} completed, ${stats.failed} failed)`);
          console.log(`[Monitor] 🔄 Auto-recovering: resetting status to 'thread_sync'`);
          
          await this.resetBackfillStatus(configData.id);
        }
      }
    } catch (error) {
      console.error('[Monitor] Error in checkForPrematureCompletions:', error);
    }
  }
  
  private async getCompletedBackfills(): Promise<ActiveConfig[]> {
    try {
      const { data, error } = await this.supabase
        .from('support_inbox_configurations')
        .select('id, inbox_id, backfill_status, backfill_started_at')
        .eq('backfill_status', 'completed')
        .not('backfill_started_at', 'is', null); // Only check configs that actually started
      
      if (error) {
        console.error('[Monitor] Error fetching completed backfills:', error);
        return [];
      }
      
      return (data || []) as ActiveConfig[];
    } catch (error) {
      console.error('[Monitor] Error in getCompletedBackfills:', error);
      return [];
    }
  }
  
  private async resetBackfillStatus(configId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      
      const { error } = await this.supabase
        .from('support_inbox_configurations')
        .update({
          backfill_status: 'thread_sync',
          backfill_completed_at: null,
          updated_at: now,
        })
        .eq('id', configId);
      
      if (error) {
        console.error(`[Monitor] Error resetting backfill status for ${configId}:`, error);
        return;
      }
      
      // Also clear the completion timestamp in sync stats
      const { error: statsError } = await this.supabase
        .from('inbox_sync_stats')
        .update({
          sync_completed_at: null,
        })
        .eq('config_id', configId);
      
      if (statsError) {
        console.error(`[Monitor] Error clearing sync stats completion for ${configId}:`, statsError);
      }
      
      console.log(`[Monitor] ✅ Successfully reset backfill ${configId.substring(0, 8)}... to 'thread_sync' status`);
      
    } catch (error) {
      console.error('[Monitor] Error in resetBackfillStatus:', error);
    }
  }
}
