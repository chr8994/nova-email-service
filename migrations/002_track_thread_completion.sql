-- Migration: Track thread completion and auto-complete backfill
-- This function is called when a thread finishes processing
-- It tracks completion and automatically updates the backfill status when all threads are done

CREATE OR REPLACE FUNCTION acknowledge_thread_job(
  p_msg_id BIGINT,
  p_config_id UUID,
  p_messages_synced INT
) RETURNS void AS $$
DECLARE
  v_threads_queued INT;
  v_threads_completed INT;
BEGIN
  -- Delete the thread job from queue
  PERFORM pgmq_public.delete('thread_sync_jobs', p_msg_id);
  
  -- Increment threads completed counter and messages synced
  UPDATE support_inbox_configurations
  SET 
    backfill_progress = jsonb_set(
      COALESCE(backfill_progress, '{}'::jsonb),
      '{threads_completed}',
      to_jsonb(COALESCE((backfill_progress->>'threads_completed')::int, 0) + 1)
    ),
    backfill_progress = jsonb_set(
      COALESCE(backfill_progress, '{}'::jsonb),
      '{total_messages_synced}',
      to_jsonb(COALESCE((backfill_progress->>'total_messages_synced')::int, 0) + p_messages_synced)
    ),
    updated_at = NOW()
  WHERE id = p_config_id
  RETURNING 
    (backfill_progress->>'threads_queued')::int,
    (backfill_progress->>'threads_completed')::int
  INTO v_threads_queued, v_threads_completed;
  
  -- Log progress
  RAISE NOTICE 'Config %: Thread completed (% of % threads)', 
    p_config_id, 
    v_threads_completed, 
    v_threads_queued;
  
  -- Check if all threads are done
  IF v_threads_completed >= v_threads_queued AND v_threads_queued > 0 THEN
    UPDATE support_inbox_configurations
    SET 
      backfill_status = 'completed',
      backfill_completed_at = NOW(),
      updated_at = NOW()
    WHERE id = p_config_id;
    
    RAISE NOTICE 'Backfill COMPLETED for config %: % threads, % messages total', 
      p_config_id, 
      v_threads_completed,
      (SELECT (backfill_progress->>'total_messages_synced')::int 
       FROM support_inbox_configurations 
       WHERE id = p_config_id);
  END IF;
  
END;
$$ LANGUAGE plpgsql;

-- Add helpful comment
COMMENT ON FUNCTION acknowledge_thread_job IS 
  'Acknowledges a completed thread sync job and automatically marks backfill as completed when all threads are done';
