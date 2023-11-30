CREATE TABLE `knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`input` text NOT NULL,
	`output` text NOT NULL,
	`original_input` text NOT NULL,
	`original_output` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_output_unique` ON `knowledge` (`output`);