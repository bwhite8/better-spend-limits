CREATE TABLE `app_config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_employee_id` text,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`target_employee_id` text,
	`target_user_id` text,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`claude_user_id` text,
	`direct_manager_id` text,
	`tier2_manager_id` text,
	`tier3_manager_id` text,
	`tier4_manager_id` text,
	`aligned_ai_lead_id` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`direct_manager_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tier2_manager_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tier3_manager_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tier4_manager_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`aligned_ai_lead_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_email_unique` ON `employees` (`email`);--> statement-breakpoint
CREATE TABLE `increase_request_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text,
	`actor_email` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`spend_summary` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spend_limit_snapshot` (
	`user_id` text PRIMARY KEY NOT NULL,
	`actor_name` text,
	`actor_email` text,
	`actor_deleted` integer DEFAULT false NOT NULL,
	`amount` text,
	`currency` text,
	`period` text,
	`source_type` text,
	`source_detail` text,
	`spend_limit_id` text,
	`period_to_date_spend` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`resource` text PRIMARY KEY NOT NULL,
	`last_synced_at` text,
	`data_refreshed_at` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `user_daily_cost` (
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` text NOT NULL,
	`provisional` integer DEFAULT false NOT NULL,
	`synced_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `date`)
);
