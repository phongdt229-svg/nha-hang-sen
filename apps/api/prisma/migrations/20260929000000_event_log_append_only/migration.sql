-- event_log là sổ append-only (mục 6): chỉ được đánh dấu published_at một lần, không sửa nội dung, không xóa.
CREATE OR REPLACE FUNCTION event_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event_log là append-only, không được xóa';
  END IF;
  IF NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.aggregate IS DISTINCT FROM OLD.aggregate
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.data IS DISTINCT FROM OLD.data
     OR NEW.rooms IS DISTINCT FROM OLD.rooms
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'event_log là append-only, chỉ được ghi published_at một lần';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_append_only
BEFORE UPDATE OR DELETE ON event_log
FOR EACH ROW EXECUTE FUNCTION event_log_guard();
