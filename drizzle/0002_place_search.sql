ALTER TABLE `tickets` ADD `place_search_from` integer;--> statement-breakpoint
ALTER TABLE `tickets` ADD `place_gave_up_at` integer;--> statement-breakpoint
-- Used tickets whose place was never found get one more lookup under the new rules.
UPDATE `tickets` SET `place_search_from` = `used_at` WHERE `status` = 'used' AND `kd_feed_event_id` IS NULL AND `used_at` IS NOT NULL;
