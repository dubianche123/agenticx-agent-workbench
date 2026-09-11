-- 租户级附件路由行为。默认仍然强制走私有模型；是否允许某个成员选择公网模型，
-- 还必须同时经过能力包中的 feature:attachment_public_override 授权。

CREATE TABLE IF NOT EXISTS `enterprise_runtime_attachment_routing` (
  `tenant_id` varchar(26) NOT NULL,
  `allow_public_override` boolean NOT NULL DEFAULT false,
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (`tenant_id`)
);
