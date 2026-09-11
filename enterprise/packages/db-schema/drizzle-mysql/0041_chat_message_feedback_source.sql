-- Preserve the original web feedback contract while allowing a desktop
-- bridge to persist ratings for messages that only exist in its local store.
ALTER TABLE `chat_message_feedback`
  MODIFY COLUMN `session_id` varchar(26) NULL,
  MODIFY COLUMN `message_id` varchar(26) NULL,
  ADD COLUMN `source` varchar(16) NOT NULL DEFAULT 'web',
  ADD COLUMN `external_session_id` varchar(128),
  ADD COLUMN `external_message_id` varchar(128),
  ADD COLUMN `answer_excerpt` text;
--> statement-breakpoint
ALTER TABLE `chat_message_feedback`
  ADD CONSTRAINT `chat_message_feedback_source_check`
    CHECK (`source` in ('web', 'desktop'));
--> statement-breakpoint
ALTER TABLE `chat_message_feedback`
  ADD CONSTRAINT `chat_message_feedback_source_identity_check`
    CHECK (
      (`source` = 'web'
        AND `session_id` IS NOT NULL
        AND `message_id` IS NOT NULL
        AND `external_session_id` IS NULL
        AND `external_message_id` IS NULL)
      OR
      (`source` = 'desktop'
        AND `session_id` IS NULL
        AND `message_id` IS NULL
        AND `external_session_id` IS NOT NULL
        AND `external_message_id` IS NOT NULL)
    );
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_message_feedback_tenant_source_external_identity_uq`
  ON `chat_message_feedback` (
    `tenant_id`,
    `user_id`,
    `source`,
    `external_session_id`,
    `external_message_id`
  );
