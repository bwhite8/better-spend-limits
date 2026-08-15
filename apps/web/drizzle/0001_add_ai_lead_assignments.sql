CREATE TABLE `ai_lead_assignments` (
	`lead_employee_id` text NOT NULL,
	`leader_employee_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`lead_employee_id`, `leader_employee_id`),
	FOREIGN KEY (`lead_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`leader_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
