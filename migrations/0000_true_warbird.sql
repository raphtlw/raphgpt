CREATE TABLE `local_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `personality` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`content` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `solana_wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`private_key` text NOT NULL,
	`public_key` text NOT NULL,
	`balance_lamports` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`user_id` integer,
	`username` text,
	`first_name` text,
	`last_name` text,
	`credits` integer DEFAULT 0 NOT NULL,
	`solana_wallet_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_user_id_unique` ON `users` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_solana_wallet_id_unique` ON `users` (`solana_wallet_id`);