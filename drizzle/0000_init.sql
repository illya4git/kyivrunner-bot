CREATE TABLE `credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_enc` blob NOT NULL,
	`token_iv` blob NOT NULL,
	`token_tag` blob NOT NULL,
	`device_uuid` text NOT NULL,
	`token_sub` text,
	`token_exp` integer,
	`status` text NOT NULL,
	`added_by` integer NOT NULL,
	`added_at` integer NOT NULL,
	`last_ok_at` integer,
	`last_error_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`tg_id` integer,
	`role_at_time` text,
	`kind` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `events_tg_ts_idx` ON `events` (`tg_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_kind_ts_idx` ON `events` (`kind`,`ts`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kd_ticket_id` integer NOT NULL,
	`user_tg_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`code` text NOT NULL,
	`kyiv_day` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` integer NOT NULL,
	`expire_at` integer NOT NULL,
	`used_at` integer,
	`place` text,
	`mode` text,
	`kd_feed_event_id` text,
	`place_attempts` integer DEFAULT 0 NOT NULL,
	`chat_id` integer,
	`message_id` integer,
	`message_gone` integer DEFAULT false NOT NULL,
	`resend_count` integer DEFAULT 0 NOT NULL,
	`status_reply_id` integer,
	`image_retired` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_tg_id`) REFERENCES `users`(`tg_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tickets_status_chk" CHECK("tickets"."status" IN ('active','used','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_kd_ticket_id_unique` ON `tickets` (`kd_ticket_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tickets_kd_feed_event_id_unique` ON `tickets` (`kd_feed_event_id`);--> statement-breakpoint
CREATE INDEX `tickets_user_day_idx` ON `tickets` (`user_tg_id`,`kyiv_day`);--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);--> statement-breakpoint
CREATE INDEX `tickets_day_idx` ON `tickets` (`kyiv_day`);--> statement-breakpoint
CREATE TABLE `users` (
	`tg_id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`first_name` text,
	`last_name` text,
	`locale` text DEFAULT 'uk' NOT NULL,
	`locale_overridden` integer DEFAULT false NOT NULL,
	`role` text DEFAULT 'guest' NOT NULL,
	`daily_quota` integer,
	`access_requested_at` integer,
	`request_ignored_at` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`role_changed_at` integer,
	`role_changed_by` integer,
	CONSTRAINT "users_role_chk" CHECK("users"."role" IN ('guest','user','admin','banned')),
	CONSTRAINT "users_locale_chk" CHECK("users"."locale" IN ('uk','en'))
);
--> statement-breakpoint
CREATE INDEX `users_username_idx` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);