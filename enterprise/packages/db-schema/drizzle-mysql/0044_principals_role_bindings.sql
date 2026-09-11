-- Durable authorization principals and explicit role/scope bindings.
-- Ambiguous custom legacy scopes are retained as unresolved and fail closed.

CREATE TABLE IF NOT EXISTS `principals` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `user_id` varchar(26),
  `display_name` varchar(128),
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `authz_version` int NOT NULL DEFAULT 1,
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `principals_id` PRIMARY KEY (`id`),
  CONSTRAINT `principals_kind_check` CHECK (`kind` IN ('user', 'agent')),
  CONSTRAINT `principals_status_check` CHECK (`status` IN ('active', 'disabled')),
  CONSTRAINT `principals_kind_user_check` CHECK ((`kind` = 'user' AND `user_id` IS NOT NULL) OR (`kind` = 'agent' AND `user_id` IS NULL)),
  CONSTRAINT `principals_user_tenant_fk` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `users` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `principals_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `principals_tenant_user_uq` UNIQUE (`tenant_id`, `user_id`),
  CONSTRAINT `principals_id_tenant_uq` UNIQUE (`id`, `tenant_id`),
  KEY `principals_tenant_kind_idx` (`tenant_id`, `kind`, `status`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_profiles` (
  `principal_id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `mode` varchar(16) NOT NULL,
  `owner_user_id` varchar(26),
  `definition_ref` varchar(128),
  `definition_version` int NOT NULL DEFAULT 1,
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `agent_profiles_principal_id` PRIMARY KEY (`principal_id`),
  CONSTRAINT `agent_profiles_mode_check` CHECK (`mode` IN ('delegated', 'service')),
  CONSTRAINT `agent_profiles_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `agent_profiles_principal_tenant_fk` FOREIGN KEY (`principal_id`, `tenant_id`) REFERENCES `principals` (`id`, `tenant_id`) ON DELETE CASCADE,
  CONSTRAINT `agent_profiles_owner_tenant_fk` FOREIGN KEY (`owner_user_id`, `tenant_id`) REFERENCES `users` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `agent_profiles_principal_tenant_uq` UNIQUE (`principal_id`, `tenant_id`),
  KEY `agent_profiles_tenant_mode_idx` (`tenant_id`, `mode`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_id_tenant_uq` ON `roles` (`id`, `tenant_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_id_tenant_uq` ON `organizations` (`id`, `tenant_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `dept_id_tenant_uq` ON `departments` (`id`, `tenant_id`);
--> statement-breakpoint
-- Legacy role rows are tenant-scoped as well.  Replace the historical
-- single-column FKs so an id from another tenant cannot be attached here.
-- Drop rows that cannot satisfy the tenant-scoped references before adding
-- the constraints. Keeping an orphaned legacy row would make this migration
-- fail and would leave authorization data with an ambiguous tenant owner.
DELETE ur
FROM `user_roles` ur
LEFT JOIN `users` u ON u.`id` = ur.`user_id` AND u.`tenant_id` = ur.`tenant_id`
LEFT JOIN `roles` r ON r.`id` = ur.`role_id` AND r.`tenant_id` = ur.`tenant_id`
LEFT JOIN `organizations` o ON o.`id` = ur.`scope_org_id` AND o.`tenant_id` = ur.`tenant_id`
LEFT JOIN `departments` d ON d.`id` = ur.`scope_dept_id` AND d.`tenant_id` = ur.`tenant_id`
WHERE u.`id` IS NULL
   OR r.`id` IS NULL
   OR (ur.`scope_org_id` IS NOT NULL AND o.`id` IS NULL)
   OR (ur.`scope_dept_id` IS NOT NULL AND d.`id` IS NULL);
--> statement-breakpoint
ALTER TABLE `user_roles`
  DROP FOREIGN KEY `user_roles_user_id_users_id_fk`,
  DROP FOREIGN KEY `user_roles_role_id_roles_id_fk`,
  DROP FOREIGN KEY `user_roles_scope_org_id_organizations_id_fk`,
  DROP FOREIGN KEY `user_roles_scope_dept_id_departments_id_fk`;
--> statement-breakpoint
ALTER TABLE `user_roles`
  ADD CONSTRAINT `user_roles_user_tenant_fk` FOREIGN KEY (`user_id`, `tenant_id`) REFERENCES `users` (`id`, `tenant_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `user_roles_role_tenant_fk` FOREIGN KEY (`role_id`, `tenant_id`) REFERENCES `roles` (`id`, `tenant_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `user_roles_scope_org_tenant_fk` FOREIGN KEY (`scope_org_id`, `tenant_id`) REFERENCES `organizations` (`id`, `tenant_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `user_roles_scope_dept_tenant_fk` FOREIGN KEY (`scope_dept_id`, `tenant_id`) REFERENCES `departments` (`id`, `tenant_id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `principal_role_bindings` (
  `id` varchar(26) NOT NULL,
  `tenant_id` varchar(26) NOT NULL,
  `principal_id` varchar(26) NOT NULL,
  `role_id` varchar(26) NOT NULL,
  `data_scope` varchar(24) NOT NULL,
  `scope_org_id` varchar(26),
  `scope_dept_id` varchar(26),
  `expires_at` datetime(6),
  `granted_by_principal_id` varchar(26),
  `can_delegate` boolean NOT NULL DEFAULT false,
  `grantor_approval_ref` varchar(160),
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `resolution` varchar(16) NOT NULL DEFAULT 'resolved',
  `resolution_reason` varchar(512),
  `source` varchar(16) NOT NULL DEFAULT 'explicit',
  `created_by_user_id` varchar(26),
  `created_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  `updated_at` datetime(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  CONSTRAINT `principal_role_bindings_id` PRIMARY KEY (`id`),
  CONSTRAINT `principal_role_bindings_data_scope_check` CHECK (`data_scope` IN ('self', 'department', 'department_subtree', 'tenant')),
  CONSTRAINT `principal_role_bindings_status_check` CHECK (`status` IN ('active', 'revoked')),
  CONSTRAINT `principal_role_bindings_resolution_check` CHECK (`resolution` IN ('resolved', 'unresolved')),
  CONSTRAINT `principal_role_bindings_source_check` CHECK (`source` IN ('legacy', 'explicit')),
  CONSTRAINT `principal_role_bindings_department_scope_check` CHECK ((`data_scope` IN ('department', 'department_subtree') AND `scope_dept_id` IS NOT NULL) OR (`data_scope` IN ('self', 'tenant') AND `scope_dept_id` IS NULL)),
  CONSTRAINT `principal_role_bindings_tenant_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `principal_role_bindings_principal_tenant_fk` FOREIGN KEY (`principal_id`, `tenant_id`) REFERENCES `principals` (`id`, `tenant_id`) ON DELETE CASCADE,
  CONSTRAINT `principal_role_bindings_granted_by_principal_tenant_fk` FOREIGN KEY (`granted_by_principal_id`, `tenant_id`) REFERENCES `principals` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `principal_role_bindings_role_tenant_fk` FOREIGN KEY (`role_id`, `tenant_id`) REFERENCES `roles` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `principal_role_bindings_scope_org_fk` FOREIGN KEY (`scope_org_id`, `tenant_id`) REFERENCES `organizations` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `principal_role_bindings_scope_dept_fk` FOREIGN KEY (`scope_dept_id`, `tenant_id`) REFERENCES `departments` (`id`, `tenant_id`) ON DELETE RESTRICT,
  CONSTRAINT `principal_role_bindings_created_by_user_fk` FOREIGN KEY (`created_by_user_id`, `tenant_id`) REFERENCES `users` (`id`, `tenant_id`) ON DELETE RESTRICT,
  KEY `principal_role_bindings_tenant_principal_idx` (`tenant_id`, `principal_id`, `status`, `expires_at`),
  KEY `principal_role_bindings_tenant_role_idx` (`tenant_id`, `role_id`),
  KEY `principal_role_bindings_grantor_idx` (`tenant_id`, `granted_by_principal_id`)
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `actor_principal_id` varchar(26) NULL;
--> statement-breakpoint
ALTER TABLE `audit_events` ADD COLUMN `grantor_principal_id` varchar(26) NULL;
--> statement-breakpoint
ALTER TABLE `audit_events`
  ADD CONSTRAINT `audit_events_actor_principal_tenant_fk` FOREIGN KEY (`actor_principal_id`, `tenant_id`) REFERENCES `principals` (`id`, `tenant_id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `audit_events_grantor_principal_tenant_fk` FOREIGN KEY (`grantor_principal_id`, `tenant_id`) REFERENCES `principals` (`id`, `tenant_id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX `audit_events_principals_idx` ON `audit_events` (`tenant_id`, `grantor_principal_id`, `actor_principal_id`);
--> statement-breakpoint
INSERT INTO `principals` (`id`, `tenant_id`, `kind`, `user_id`, `display_name`, `status`, `authz_version`, `created_at`, `updated_at`)
SELECT SUBSTRING(MD5(CONCAT(u.`tenant_id`, ':user:', u.`id`)), 1, 26), u.`tenant_id`, 'user', u.`id`, u.`display_name`, CASE WHEN u.`status` = 'disabled' OR u.`is_deleted` OR u.`deleted_at` IS NOT NULL THEN 'disabled' ELSE 'active' END, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
FROM `users` u
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`), `status` = VALUES(`status`), `updated_at` = UTC_TIMESTAMP(6);
--> statement-breakpoint
INSERT INTO `principal_role_bindings` (`id`, `tenant_id`, `principal_id`, `role_id`, `data_scope`, `scope_org_id`, `scope_dept_id`, `expires_at`, `granted_by_principal_id`, `can_delegate`, `grantor_approval_ref`, `status`, `resolution`, `resolution_reason`, `source`, `created_at`, `updated_at`)
SELECT SUBSTRING(MD5(CONCAT(ur.`tenant_id`, ':binding:', ur.`user_id`, ':', ur.`role_id`)), 1, 26), ur.`tenant_id`, p.`id`, ur.`role_id`,
  CASE
    WHEN r.`code` IN ('super_admin', 'owner', 'admin', 'auditor') THEN 'tenant'
    WHEN r.`code` = 'dept_admin' AND d.`id` IS NOT NULL THEN 'department'
    WHEN r.`code` = 'member' THEN 'self'
    ELSE 'self'
  END,
  CASE WHEN o.`id` IS NOT NULL THEN ur.`scope_org_id` ELSE NULL END,
  CASE WHEN r.`code` = 'dept_admin' AND d.`id` IS NOT NULL THEN ur.`scope_dept_id` ELSE NULL END,
  NULL,
  NULL,
  CASE WHEN r.`code` IN ('super_admin', 'owner', 'admin') OR JSON_CONTAINS(r.`scopes`, JSON_QUOTE('role:assign')) THEN 1 ELSE 0 END,
  NULL,
  'active',
  CASE WHEN r.`code` IN ('super_admin', 'owner', 'admin', 'auditor', 'member') OR (r.`code` = 'dept_admin' AND d.`id` IS NOT NULL) THEN 'resolved' ELSE 'unresolved' END,
  CASE WHEN r.`code` IN ('super_admin', 'owner', 'admin', 'auditor', 'member') OR (r.`code` = 'dept_admin' AND d.`id` IS NOT NULL) THEN NULL ELSE 'legacy role scope is ambiguous; explicit data scope required' END,
  'legacy',
  ur.`created_at`, ur.`updated_at`
FROM `user_roles` ur
JOIN `roles` r ON r.`id` = ur.`role_id` AND r.`tenant_id` = ur.`tenant_id`
JOIN `principals` p ON p.`tenant_id` = ur.`tenant_id` AND p.`user_id` = ur.`user_id`
LEFT JOIN `organizations` o ON o.`id` = ur.`scope_org_id` AND o.`tenant_id` = ur.`tenant_id`
LEFT JOIN `departments` d ON d.`id` = ur.`scope_dept_id` AND d.`tenant_id` = ur.`tenant_id`
ON DUPLICATE KEY UPDATE `updated_at` = VALUES(`updated_at`);
