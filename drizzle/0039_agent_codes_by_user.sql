-- Codes live 30-60 minutes and cannot be re-keyed from account to user in place; outstanding ones are dropped.
DELETE FROM "agent_codes";--> statement-breakpoint
ALTER TABLE "agent_codes" DROP CONSTRAINT "agent_codes_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "agent_codes" DROP COLUMN "account_id";--> statement-breakpoint
ALTER TABLE "agent_codes" ADD COLUMN "user_id" text PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_codes" ADD CONSTRAINT "agent_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
