CREATE INDEX "ledger_entries_market_id_idx" ON "ledger_entries" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "markets_maker_account_id_idx" ON "markets" USING btree ("maker_account_id");--> statement-breakpoint
CREATE INDEX "orders_outcome_id_idx" ON "orders" USING btree ("outcome_id");