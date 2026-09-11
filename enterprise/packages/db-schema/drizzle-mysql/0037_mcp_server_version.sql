ALTER TABLE `mcp_servers` ADD COLUMN `version` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '0.0.0' AFTER `name`;
