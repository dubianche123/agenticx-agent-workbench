-- Keep PAT-bound desktop sessions distinct from server-owned cookie sessions.
-- Cookie sessions intentionally store NULL provenance; they must never point at
-- an api_tokens row or use a numeric sentinel.
ALTER TABLE `assistant_sessions`
  ADD COLUMN `origin_kind` varchar(24) NOT NULL DEFAULT 'desktop_pat';
--> statement-breakpoint
ALTER TABLE `assistant_sessions`
  MODIFY COLUMN `originating_pat_id` bigint NULL;
--> statement-breakpoint
ALTER TABLE `assistant_sessions`
  ADD CONSTRAINT `assistant_sessions_origin_check` CHECK (
    (`origin_kind` = 'desktop_pat' AND `originating_pat_id` IS NOT NULL)
    OR (`origin_kind` IN ('admin_cookie', 'portal_cookie') AND `originating_pat_id` IS NULL)
  );
