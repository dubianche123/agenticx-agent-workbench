CREATE TABLE IF NOT EXISTS `chat_message_feedback` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `user_id` varchar(26) NOT NULL,
  `department_id` varchar(26),
  `session_id` varchar(26) NOT NULL,
  `message_id` varchar(26) NOT NULL,
  `value` varchar(16) NOT NULL,
  `trace_id` varchar(128),
  `provider` varchar(128),
  `model` varchar(160),
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `chat_message_feedback_pk` PRIMARY KEY (`id`),
  CONSTRAINT `chat_message_feedback_value_check` CHECK (`value` in ('like', 'dislike')),
  CONSTRAINT `chat_message_feedback_tenant_fk`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chat_message_feedback_user_fk`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `chat_message_feedback_session_fk`
    FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `chat_message_feedback_message_fk`
    FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON DELETE CASCADE,
  CONSTRAINT `chat_message_feedback_session_tenant_user_fk`
    FOREIGN KEY (`session_id`, `tenant_id`, `user_id`)
    REFERENCES `chat_sessions`(`id`, `tenant_id`, `user_id`) ON DELETE RESTRICT,
  UNIQUE KEY `chat_message_feedback_tenant_user_message_uq` (`tenant_id`, `user_id`, `message_id`),
  INDEX `chat_message_feedback_tenant_message_value_idx` (`tenant_id`, `message_id`, `value`),
  INDEX `chat_message_feedback_tenant_department_created_idx` (`tenant_id`, `department_id`, `created_at`),
  INDEX `chat_message_feedback_tenant_model_created_idx` (`tenant_id`, `model`, `created_at`)
);
