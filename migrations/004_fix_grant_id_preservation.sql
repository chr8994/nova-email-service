-- Fix insert_queued_thread_idempotent to preserve grant_id on conflict
-- This ensures that grant_id is not lost when threads are re-queued

CREATE OR REPLACE FUNCTION insert_queued_thread_idempotent(
  p_config_id UUID,
  p_inbox_id UUID,
  p_thread_id VARCHAR,
  p_grant_id VARCHAR
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO queued_threads (
    config_id, 
    inbox_id, 
    thread_id, 
    nylas_thread_id, 
    grant_id, 
    status
  )
  VALUES (
    p_config_id, 
    p_inbox_id, 
    p_thread_id, 
    p_thread_id, 
    p_grant_id, 
    'queued'
  )
  ON CONFLICT (config_id, nylas_thread_id) 
  DO UPDATE SET 
    queued_at = EXCLUDED.queued_at,
    status = 'queued',
    grant_id = EXCLUDED.grant_id;  -- CRITICAL FIX: Preserve grant_id
END;
$$ LANGUAGE plpgsql;
