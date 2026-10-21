-- last_message_at 由触发器维护：消息有两个写入方（API repo 与 worker，后者在事务里先删后写），
-- 靠调用方自觉更新会漏。语句级触发器一次语句只重算一次。
CREATE FUNCTION refresh_conversation_last_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE conversations c SET last_message_at = COALESCE(
      (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at)
    WHERE c.id IN (SELECT conversation_id FROM new_rows);
  ELSE
    UPDATE conversations c SET last_message_at = COALESCE(
      (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at)
    WHERE c.id IN (SELECT conversation_id FROM old_rows);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_last_message_ins
AFTER INSERT ON messages
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_conversation_last_message();
--> statement-breakpoint
CREATE TRIGGER messages_last_message_del
AFTER DELETE ON messages
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_conversation_last_message();
