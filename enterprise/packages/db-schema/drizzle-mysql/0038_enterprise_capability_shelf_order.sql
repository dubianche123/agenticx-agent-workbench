CREATE TABLE IF NOT EXISTS `enterprise_capability_shelf_order` (
  `tenant_id` varchar(26) NOT NULL,
  `capability_id` varchar(64) NOT NULL,
  `position` int NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `enterprise_capability_shelf_order_pk` PRIMARY KEY (`tenant_id`, `capability_id`),
  CONSTRAINT `enterprise_capability_shelf_order_tenant_fk`
    FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE,
  INDEX `enterprise_capability_shelf_order_tenant_position_idx`
    (`tenant_id`, `position`, `capability_id`)
);
