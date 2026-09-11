-- Market visibility and forced delivery are separate administrator controls.
-- An item can be unlisted for employees while an existing capability pack keeps
-- delivering its approved immutable release. Emergency revoke changes only this
-- field and is reversible by an administrator.
ALTER TABLE `enterprise_config_market_items`
  ADD COLUMN `delivery_state` varchar(16) NOT NULL DEFAULT 'active';
