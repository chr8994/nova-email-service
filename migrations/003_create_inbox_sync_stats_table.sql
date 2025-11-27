-- Migration: Create inbox_sync_stats table for better visibility and performance
-- This replaces the JSONB approach with a proper normalized table

-- Create the sync stats table
CREATE TABLE IF NOT EXISTS inbox_sync_stats (
  config_id UUID PRIMARY KEY REFERENCES support_inbox_configurations(id) ON DELETE CASCADE,
  
  -- Thread tracking
  threads_total INT DEFAULT 0 NOT NULL,           -- Total threads found by Nylas
  threads_queued INT DEFAULT 0 NOT NULL,          -- Threads added to queue
  threads_processing INT DEFAULT 0 NOT NULL,      -- Currently being processed
  threads_completed INT DEFAULT 0 NOT NULL,       -- Successfully synced
  threads_failed INT DEFAULT 0 NOT NULL,          -- Failed to sync
  
  -- Message tracking
  messages_total INT DEFAULT 0 NOT NULL,          -- Estimated total messages
  messages_synced INT DEFAULT 0 NOT NULL,         -- Messages successfully synced
  
  -- Timestamps
  sync_started_at TIMESTAMP,
  last_thread_at TIMESTAMP,                       -- When last thread was processed
  sync_completed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for fast queries
CREATE INDEX idx_sync_stats_processing ON inbox_sync_stats(threads_processing) WHERE threads_processing > 0;
CREATE INDEX idx_sync_stats_in_progress ON inbox_sync_stats(sync_started_at) WHERE sync_completed_at IS NULL;
CREATE INDEX idx_sync_stats_completed ON inbox_sync_stats(sync_completed_at) WHERE sync_completed_at IS NOT NULL;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_inbox_sync_stats_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER trigger_update_inbox_sync_stats_updated_at
  BEFORE UPDATE ON inbox_sync_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_inbox_sync_stats_updated_at();

-- Function to initialize sync stats when backfill starts
CREATE OR REPLACE FUNCTION initialize_sync_stats(
  p_config_id UUID,
  p_threads_total INT
) RETURNS void AS $$
BEGIN
  INSERT INTO inbox_sync_stats (
    config_id,
    threads_total,
    threads_queued,
    sync_started_at
  )
  VALUES (
    p_config_id,
    p_threads_total,
    0,  -- Will be updated as threads are queued
    NOW()
  )
  ON CONFLICT (config_id) DO UPDATE SET
    threads_total = p_threads_total,
    threads_queued = 0,
    threads_processing = 0,
    threads_completed = 0,
    threads_failed = 0,
    messages_synced = 0,
    sync_started_at = NOW(),
    sync_completed_at = NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to increment queued threads count
CREATE OR REPLACE FUNCTION increment_threads_queued(
  p_config_id UUID
) RETURNS void AS $$
BEGIN
  INSERT INTO inbox_sync_stats (config_id, threads_queued)
  VALUES (p_config_id, 1)
  ON CONFLICT (config_id) DO UPDATE SET
    threads_queued = inbox_sync_stats.threads_queued + 1;
END;
$$ LANGUAGE plpgsql;

-- Function to mark thread as processing (called when thread job starts)
CREATE OR REPLACE FUNCTION start_thread_processing(
  p_config_id UUID
) RETURNS void AS $$
BEGIN
  UPDATE inbox_sync_stats
  SET 
    threads_processing = threads_processing + 1,
    last_thread_at = NOW()
  WHERE config_id = p_config_id;
END;
$$ LANGUAGE plpgsql;

-- Updated acknowledge_thread_job function to use new table
CREATE OR REPLACE FUNCTION acknowledge_thread_job(
  p_msg_id BIGINT,
  p_config_id UUID,
  p_messages_synced INT,
  p_success BOOLEAN DEFAULT TRUE
) RETURNS void AS $$
DECLARE
  v_threads_queued INT;
  v_threads_completed INT;
  v_threads_failed INT;
BEGIN
  -- Delete the thread job from queue
  PERFORM pgmq_public.delete('thread_sync_jobs', p_msg_id);
  
  -- Update stats table
  UPDATE inbox_sync_stats
  SET 
    threads_processing = GREATEST(threads_processing - 1, 0),
    threads_completed = CASE WHEN p_success THEN threads_completed + 1 ELSE threads_completed END,
    threads_failed = CASE WHEN NOT p_success THEN threads_failed + 1 ELSE threads_failed END,
    messages_synced = messages_synced + p_messages_synced,
    last_thread_at = NOW()
  WHERE config_id = p_config_id
  RETURNING threads_queued, threads_completed, threads_failed
  INTO v_threads_queued, v_threads_completed, v_threads_failed;
  
  -- Log progress
  RAISE NOTICE 'Config %: Thread % (% of % threads, % failed)', 
    p_config_id,
    CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
    v_threads_completed + v_threads_failed,
    v_threads_queued,
    v_threads_failed;
  
  -- Check if all threads are done (completed + failed >= queued)
  IF (v_threads_completed + v_threads_failed) >= v_threads_queued AND v_threads_queued > 0 THEN
    -- Mark sync as completed
    UPDATE inbox_sync_stats
    SET sync_completed_at = NOW()
    WHERE config_id = p_config_id;
    
    -- Update configuration status
    UPDATE support_inbox_configurations
    SET 
      backfill_status = 'completed',
      backfill_completed_at = NOW(),
      updated_at = NOW()
    WHERE id = p_config_id;
    
    RAISE NOTICE 'Sync COMPLETED for config %: % threads (% completed, % failed), % messages total', 
      p_config_id, 
      v_threads_queued,
      v_threads_completed,
      v_threads_failed,
      (SELECT messages_synced FROM inbox_sync_stats WHERE config_id = p_config_id);
  END IF;
  
END;
$$ LANGUAGE plpgsql;

-- Migrate existing data from backfill_progress JSONB (if any)
DO $$
DECLARE
  config RECORD;
BEGIN
  FOR config IN 
    SELECT 
      id as config_id,
      (backfill_progress->>'threads_queued')::int as threads_queued,
      (backfill_progress->>'threads_completed')::int as threads_completed,
      (backfill_progress->>'total_messages_synced')::int as messages_synced,
      backfill_started_at,
      backfill_completed_at
    FROM support_inbox_configurations
    WHERE backfill_progress IS NOT NULL
      AND backfill_progress->>'threads_queued' IS NOT NULL
  LOOP
    INSERT INTO inbox_sync_stats (
      config_id,
      threads_queued,
      threads_completed,
      messages_synced,
      sync_started_at,
      sync_completed_at
    )
    VALUES (
      config.config_id,
      COALESCE(config.threads_queued, 0),
      COALESCE(config.threads_completed, 0),
      COALESCE(config.messages_synced, 0),
      config.backfill_started_at,
      config.backfill_completed_at
    )
    ON CONFLICT (config_id) DO NOTHING;
  END LOOP;
END $$;

-- Add helpful comments
COMMENT ON TABLE inbox_sync_stats IS 'Tracks real-time statistics for inbox sync operations';
COMMENT ON FUNCTION acknowledge_thread_job IS 'Acknowledges a completed thread sync job and updates statistics';
COMMENT ON FUNCTION initialize_sync_stats IS 'Initializes sync stats when a backfill starts';
COMMENT ON FUNCTION increment_threads_queued IS 'Increments the queued threads counter';
COMMENT ON FUNCTION start_thread_processing IS 'Marks a thread as currently processing';
