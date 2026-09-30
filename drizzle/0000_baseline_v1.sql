CREATE TYPE "public"."access_event" AS ENUM('login_success', 'login_failed', 'logout', 'totp_failed', 'pin_failed', 'pin_locked', 'session_expired', 'session_revoked', 'device_registered', 'device_activated', 'device_rejected', 'device_blocked', 'device_wipe_requested', 'device_wiped', 'export', 'action_denied', 'password_changed', 'pin_reset', 'totp_reset');--> statement-breakpoint
CREATE TYPE "public"."access_review_status" AS ENUM('draft', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."actor_source" AS ENUM('web', 'field', 'pos', 'system', 'customer_app', 'partner_portal');--> statement-breakpoint
CREATE TYPE "public"."anonymization_status" AS ENUM('submitted', 'approved', 'rejected', 'executed', 'deferred');--> statement-breakpoint
CREATE TYPE "public"."anonymization_subject" AS ENUM('customer', 'employee', 'customer_account');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('submitted', 'approved', 'rejected', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."backup_kind" AS ENUM('daily', 'monthly', 'restore_test');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cash_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."check_result" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."customer_segment" AS ENUM('third_party_depot', 'household', 'housing', 'industry', 'construction', 'hotel', 'swimming_pool');--> statement-breakpoint
CREATE TYPE "public"."data_signoff_group" AS ENUM('customers', 'tariffs_prices', 'fleet_people', 'outlets_sources', 'stock_opening', 'fixed_assets', 'opening_cash_bank', 'opening_receivables', 'opening_payables', 'chart_of_accounts', 'initial_accounts', 'opening_equity');--> statement-breakpoint
CREATE TYPE "public"."delivery_slot" AS ENUM('morning', 'midday', 'afternoon');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('phone', 'tablet', 'gps');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('registered', 'active', 'blocked', 'wipe_pending', 'wiped');--> statement-breakpoint
CREATE TYPE "public"."export_format" AS ENUM('xlsx', 'pdf', 'csv');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_scope" AS ENUM('global', 'tenant', 'outlet', 'truck');--> statement-breakpoint
CREATE TYPE "public"."geofence_location_type" AS ENUM('water_source', 'outlet', 'pool');--> statement-breakpoint
CREATE TYPE "public"."gps_state" AS ENUM('active', 'dead', 'unplugged');--> statement-breakpoint
CREATE TYPE "public"."grant_status" AS ENUM('pending', 'active', 'revoked', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."incident_kind" AS ENUM('service_down', 'mass_sync_failure', 'gps_device_dead', 'lost_device_queue', 'security', 'other');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('critical', 'major', 'minor');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('open', 'acknowledged', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."job_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_mode" AS ENUM('immediate', 'daily_digest', 'off');--> statement-breakpoint
CREATE TYPE "public"."notification_severity" AS ENUM('critical', 'high', 'normal', 'info');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('new', 'read', 'actioned', 'done');--> statement-breakpoint
CREATE TYPE "public"."outlet_kind" AS ENUM('depot', 'store');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'transfer', 'credit', 'qris', 'internal', 'digital');--> statement-breakpoint
CREATE TYPE "public"."price_kind" AS ENUM('standard', 'general', 'partner');--> statement-breakpoint
CREATE TYPE "public"."price_status" AS ENUM('pending', 'active', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."profit_center" AS ENUM('L1', 'L2', 'L3', 'L4', 'L5', 'SHARED');--> statement-breakpoint
CREATE TYPE "public"."role_code" AS ENUM('owner', 'finance_admin', 'dispatcher', 'driver', 'helper', 'depot_operator', 'store_cashier', 'production_operator', 'system_admin', 'accountant', 'partner_owner', 'regional_coach');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('truck', 'outlet', 'water_source', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('web', 'device');--> statement-breakpoint
CREATE TYPE "public"."signoff_status" AS ENUM('draft', 'signed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sync_command_status" AS ENUM('applied', 'rejected', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."tenant_kind" AS ENUM('owner', 'partner');--> statement-breakpoint
CREATE TYPE "public"."ticket_category" AS ENUM('app_issue', 'feedback');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('received', 'answered', 'done');--> statement-breakpoint
CREATE TYPE "public"."unit_type" AS ENUM('truck', 'outlet');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending_approval', 'active', 'inactive', 'locked');--> statement-breakpoint
CREATE TYPE "public"."wa_message_kind" AS ENUM('order_confirmation', 'trip_receipt', 'payment_receipt', 'reminder_before_due', 'reminder_after_due', 'monthly_invoice', 'statement', 'otp', 'order_status', 'partner_report', 'invoice', 'refill_reminder', 'customer_notice');--> statement-breakpoint
CREATE TYPE "public"."wa_message_status" AS ENUM('link_opened', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."wa_provider" AS ENUM('link', 'cloud_api');--> statement-breakpoint
CREATE TYPE "public"."coordinate_source" AS ENUM('map', 'first_delivery', 'customer_app', 'import');--> statement-breakpoint
CREATE TYPE "public"."coordinate_status" AS ENUM('unlocked', 'locked');--> statement-breakpoint
CREATE TYPE "public"."credit_status" AS ENUM('cash', 'credit', 'credit_migrated', 'on_hold');--> statement-breakpoint
CREATE TYPE "public"."distance_method" AS ENUM('route', 'straight_line_x1_3');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('customers', 'customer_prices', 'trucks', 'crew', 'employees', 'outlets', 'water_sources', 'opening_stock', 'fixed_assets', 'opening_receivables', 'opening_payables', 'chart_of_accounts');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('valid', 'error', 'duplicate', 'excluded', 'committed');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'validated', 'has_errors', 'committed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."meter_status" AS ENUM('active', 'replaced', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."meter_unit" AS ENUM('liter', 'cubic_meter');--> statement-breakpoint
CREATE TYPE "public"."product_line" AS ENUM('truck_water', 'depot', 'store');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('pending_approval', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."store_partner_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."truck_status" AS ENUM('active', 'maintenance', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."zone_assignment" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."crew_assignment_source" AS ENUM('default_driver', 'helper', 'other_driver');--> statement-breakpoint
CREATE TYPE "public"."crew_role" AS ENUM('driver', 'helper');--> statement-breakpoint
CREATE TYPE "public"."crew_roster_status" AS ENUM('on_duty', 'off');--> statement-breakpoint
CREATE TYPE "public"."loaded_water_disposition" AS ENUM('carried_to_next', 'returned_to_source', 'unloaded_at_depot');--> statement-breakpoint
CREATE TYPE "public"."location_deviation" AS ENUM('none', 'level1', 'level2');--> statement-breakpoint
CREATE TYPE "public"."location_reason" AS ENUM('wrong_master_address', 'customer_other_point', 'gps_inaccurate', 'other');--> statement-breakpoint
CREATE TYPE "public"."order_cancel_reason" AS ENUM('customer_cancelled', 'duplicate', 'no_truck', 'price', 'rejected_by_dispatcher', 'other');--> statement-breakpoint
CREATE TYPE "public"."order_price_source" AS ENUM('zone', 'special', 'internal_transfer');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('office', 'recurring', 'customer_app', 'partner_portal');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('new', 'awaiting_approval', 'scheduled', 'in_delivery', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."partial_volume_reason" AS ENUM('customer_tank_full', 'leakage', 'customer_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."recurring_failure_reason" AS ENUM('credit_on_hold', 'credit_limit', 'underpayment', 'inactive_customer', 'other');--> statement-breakpoint
CREATE TYPE "public"."recurring_pattern" AS ENUM('weekly', 'interval');--> statement-breakpoint
CREATE TYPE "public"."recurring_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."schedule_change_type" AS ENUM('added', 'moved', 'withdrawn', 'reordered', 'truck_changed');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."trip_fail_reason" AS ENUM('customer_absent', 'customer_refused', 'location_inaccessible', 'truck_broken', 'other');--> statement-breakpoint
CREATE TYPE "public"."trip_incident_kind" AS ENUM('trip_failed', 'truck_broken', 'road_blocked', 'accident', 'other');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('assigned', 'departed', 'arrived', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."truck_day_state" AS ENUM('operating', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."expense_funding_source" AS ENUM('cash_on_hand', 'personal');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('pending_verification', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."trip_expense_kind" AS ENUM('fuel', 'toll', 'parking', 'other');--> statement-breakpoint
CREATE TYPE "public"."bank_deposit_status" AS ENUM('recorded', 'matched');--> statement-breakpoint
CREATE TYPE "public"."bank_statement_line_status" AS ENUM('unmatched', 'matched', 'ignored', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."cash_close_exception_status" AS ENUM('submitted', 'approved', 'rejected', 'resolved', 'expired');--> statement-breakpoint
CREATE TYPE "public"."cash_day_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."deposit_method" AS ENUM('physical', 'bank_slip');--> statement-breakpoint
CREATE TYPE "public"."deposit_source_type" AS ENUM('driver', 'depot_shift', 'store_shift');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('running', 'submitted', 'received', 'closed');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_reason" AS ENUM('wrong_change', 'damaged_or_counterfeit', 'expense_rejected', 'unrecorded_underpayment', 'other');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_source" AS ENUM('driver', 'depot_shift', 'store_shift', 'office_cash', 'petty_cash', 'pending_deposit');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_status" AS ENUM('formed', 'explained', 'approved', 'rejected', 'followed_up', 'done');--> statement-breakpoint
CREATE TYPE "public"."incoming_transfer_status" AS ENUM('unmatched', 'matched', 'not_found', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."office_cash_kind" AS ENUM('opening_balance', 'deposit_received', 'bank_deposit', 'petty_cash_topup', 'expense_reimbursement', 'customer_payment', 'supplier_payment', 'restitution_payment', 'advance_refund', 'qris_refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."petty_cash_kind" AS ENUM('topup', 'expense');--> statement-breakpoint
CREATE TYPE "public"."petty_cash_status" AS ENUM('pending_approval', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."restitution_settlement_method" AS ENUM('cash', 'payroll_deduction');--> statement-breakpoint
CREATE TYPE "public"."restitution_status" AS ENUM('recorded', 'partially_settled', 'settled');--> statement-breakpoint
CREATE TYPE "public"."transfer_source_kind" AS ENUM('trip_payment', 'collection', 'qris_shift', 'bank_deposit_slip', 'store_collection', 'digital_payment', 'office_payment');--> statement-breakpoint
CREATE TYPE "public"."advance_status" AS ENUM('open', 'applied', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."credit_note_status" AS ENUM('issued', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('none', 'disputed', 'resolved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('underpayment', 'delivery', 'store_sale', 'monthly', 'opening_balance', 'partner_subscription');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_component" AS ENUM('trip', 'store_item', 'underpayment', 'opening_balance', 'subscription', 'royalty', 'water', 'spare_part', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'partial', 'paid');--> statement-breakpoint
CREATE TYPE "public"."payment_channel" AS ENUM('office', 'driver', 'store', 'digital');--> statement-breakpoint
CREATE TYPE "public"."receivable_line" AS ENUM('truck', 'store', 'partner');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('before_due', 'after_due', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('scheduled', 'opened', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."unbilled_status" AS ENUM('unbilled', 'billed');--> statement-breakpoint
CREATE TYPE "public"."consumable_source" AS ENUM('internal_transfer', 'supplier', 'other');--> statement-breakpoint
CREATE TYPE "public"."outlet_water_kind" AS ENUM('opening', 'supply_in', 'sales_out', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."pos_sale_status" AS ENUM('pending_approval', 'valid', 'void_pending', 'voided', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."shift_deposit_status" AS ENUM('not_deposited', 'deposited', 'received');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."shift_stock_phase" AS ENUM('opening', 'closing');--> statement-breakpoint
CREATE TYPE "public"."stock_adjust_reason" AS ENUM('damaged', 'lost', 'miscount', 'other');--> statement-breakpoint
CREATE TYPE "public"."stock_count_kind" AS ENUM('weekly_depot', 'monthly_store', 'cutover');--> statement-breakpoint
CREATE TYPE "public"."stock_count_status" AS ENUM('counting', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_kind" AS ENUM('opening', 'receipt', 'sale', 'sale_void', 'consumption', 'consumption_reversal', 'adjustment', 'transfer_out', 'transfer_in', 'supplier_return', 'correction');--> statement-breakpoint
CREATE TYPE "public"."void_reason" AS ENUM('wrong_product', 'wrong_quantity', 'customer_cancelled', 'wrong_payment_method', 'other');--> statement-breakpoint
CREATE TYPE "public"."water_supply_source" AS ENUM('equa_truck', 'other');--> statement-breakpoint
CREATE TYPE "public"."water_supply_status" AS ENUM('arrived', 'confirmed', 'discrepancy', 'auto_accepted');--> statement-breakpoint
CREATE TYPE "public"."internal_transfer_status" AS ENUM('sent', 'received');--> statement-breakpoint
CREATE TYPE "public"."payable_status" AS ENUM('unpaid', 'partial', 'paid');--> statement-breakpoint
CREATE TYPE "public"."purchase_receipt_status" AS ENUM('pending_acceptance', 'received', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."reorder_status" AS ENUM('open', 'ordered', 'closed');--> statement-breakpoint
CREATE TYPE "public"."supplier_status" AS ENUM('pending_approval', 'active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."loss_reason" AS ENUM('leakage', 'washing_disposal', 'meter_problem', 'unrecorded_fill', 'other');--> statement-breakpoint
CREATE TYPE "public"."meter_adjustment_kind" AS ENUM('rollover', 'replacement');--> statement-breakpoint
CREATE TYPE "public"."meter_phase" AS ENUM('morning', 'evening');--> statement-breakpoint
CREATE TYPE "public"."meter_reading_status" AS ENUM('recorded', 'flagged', 'verified', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."production_status" AS ENUM('incomplete', 'complete', 'combined', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."quality_location_type" AS ENUM('water_source', 'outlet');--> statement-breakpoint
CREATE TYPE "public"."truck_fill_status" AS ENUM('recorded', 'linked', 'unlinked', 'geofence_verified', 'geofence_mismatch');--> statement-breakpoint
CREATE TYPE "public"."water_balance_status" AS ENUM('formed', 'normal', 'over_threshold', 'investigating', 'done', 'negative_anomaly');--> statement-breakpoint
CREATE TYPE "public"."daily_summary_status" AS ENUM('running', 'published', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('provisional', 'final');--> statement-breakpoint
CREATE TYPE "public"."summary_addendum_kind" AS ENUM('late_sync', 'correction', 'late_deposit');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."allocation_kind" AS ENUM('l1_allocation', 'shared_costs');--> statement-breakpoint
CREATE TYPE "public"."allocation_status" AS ENUM('draft', 'posted');--> statement-breakpoint
CREATE TYPE "public"."asset_category" AS ENUM('truck', 'water_installation', 'depot_equipment', 'building', 'other');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('active', 'disposed');--> statement-breakpoint
CREATE TYPE "public"."cash_reconciliation_kind" AS ENUM('office_cash', 'outlet_fixed_cash', 'driver_cash', 'petty_cash');--> statement-breakpoint
CREATE TYPE "public"."depreciation_method" AS ENUM('straight_line', 'declining_balance');--> statement-breakpoint
CREATE TYPE "public"."journal_kind" AS ENUM('auto', 'manual', 'opening_balance', 'opening_adjustment', 'accrual', 'accrual_reversal', 'depreciation', 'allocation', 'reversal', 'reclassification');--> statement-breakpoint
CREATE TYPE "public"."journal_payable_status" AS ENUM('open', 'partial', 'paid');--> statement-breakpoint
CREATE TYPE "public"."journal_queue_reason" AS ENUM('mapping_missing', 'account_inactive', 'unbalanced', 'period_unavailable', 'other');--> statement-breakpoint
CREATE TYPE "public"."journal_queue_status" AS ENUM('pending', 'resolved', 'failed');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('draft', 'submitted', 'approved', 'posted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."normal_balance" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."opening_batch_group" AS ENUM('cash_bank', 'receivables', 'payables', 'inventory', 'fixed_assets', 'equity');--> statement-breakpoint
CREATE TYPE "public"."opening_batch_status" AS ENUM('draft', 'signed', 'posted');--> statement-breakpoint
CREATE TYPE "public"."period_review_kind" AS ENUM('review', 'retroactive_verification', 'tg8');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('open', 'closed', 'locked', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('in_progress', 'zero_difference');--> statement-breakpoint
CREATE TYPE "public"."recurring_journal_template" AS ENUM('salary', 'rent', 'electricity', 'fuel', 'maintenance', 'bank_fee', 'other');--> statement-breakpoint
CREATE TYPE "public"."tax_scheme" AS ENUM('non_pkp_final', 'non_pkp_other', 'pkp');--> statement-breakpoint
CREATE TYPE "public"."fleet_event_kind" AS ENUM('location_deviation_l1', 'location_deviation_l2', 'off_schedule_trip', 'off_hours_trip', 'unknown_stop', 'device_offline', 'device_unplugged', 'geofence_enter', 'geofence_exit', 'location_source_inconsistent', 'fill_without_geofence', 'geofence_without_fill', 'supply_without_geofence', 'no_location', 'clock_skew', 'maintenance_trip');--> statement-breakpoint
CREATE TYPE "public"."fleet_event_status" AS ENUM('detected', 'explained', 'reviewed', 'done');--> statement-breakpoint
CREATE TYPE "public"."fleet_review_decision" AS ENUM('accepted', 'request_explanation', 'follow_up');--> statement-breakpoint
CREATE TYPE "public"."phone_tracking_reason" AS ENUM('device_dead', 'admin_forced');--> statement-breakpoint
CREATE TYPE "public"."position_source" AS ENUM('gps_device', 'phone', 'status_point');--> statement-breakpoint
CREATE TYPE "public"."complaint_kind" AS ENUM('volume', 'lateness', 'attitude', 'billing', 'other');--> statement-breakpoint
CREATE TYPE "public"."complaint_status" AS ENUM('submitted', 'responded', 'done');--> statement-breakpoint
CREATE TYPE "public"."customer_account_status" AS ENUM('registered', 'verified', 'linked', 'pending_review', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."otp_purpose" AS ENUM('register', 'login', 'change_phone', 'payment');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_method" AS ENUM('qris_dynamic', 'virtual_account');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('pending', 'succeeded', 'matched', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."onboarding_item" AS ENUM('training', 'sop_signed', 'equipment_order', 'first_water_order', 'pos_device_registered', 'initial_water_test');--> statement-breakpoint
CREATE TYPE "public"."partner_audit_status" AS ENUM('scheduled', 'conducted', 'findings', 'follow_up', 'closed');--> statement-breakpoint
CREATE TYPE "public"."partner_contract_status" AS ENUM('draft', 'active', 'extended', 'ended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."partner_option" AS ENUM('option_b', 'option_a');--> statement-breakpoint
CREATE TYPE "public"."portal_order_kind" AS ENUM('water', 'spare_part');--> statement-breakpoint
CREATE TYPE "public"."portal_order_status" AS ENUM('submitted', 'confirmed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."prospect_status" AS ENUM('prospect', 'surveyed', 'feasible', 'infeasible', 'approved', 'contracted', 'onboarding', 'active', 'rejected', 'waitlisted');--> statement-breakpoint
CREATE TYPE "public"."royalty_status" AS ENUM('provisional', 'invoiced');--> statement-breakpoint
CREATE TYPE "public"."sanction_level" AS ENUM('warning', 'supply_suspension', 'termination');--> statement-breakpoint
CREATE TYPE "public"."sanction_status" AS ENUM('triggered', 'active', 'lifted', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."sanction_trigger" AS ENUM('overdue', 'water_balance', 'low_score', 'audit_overdue', 'pos_unused', 'test_failed', 'other');--> statement-breakpoint
CREATE TYPE "public"."spare_part_pickup" AS ENUM('store_pickup', 'with_truck');--> statement-breakpoint
CREATE TYPE "public"."support_request_kind" AS ENUM('equipment', 'spare_part', 'system', 'water_quality');--> statement-breakpoint
CREATE TYPE "public"."support_request_status" AS ENUM('submitted', 'responded', 'done');--> statement-breakpoint
CREATE TABLE "access_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" "access_event" NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"user_id" uuid,
	"username_attempted" text,
	"device_id" uuid,
	"ip" text,
	"user_agent" text,
	"permission" text,
	"rule" text,
	"reason" text,
	"object_type" text,
	"object_id" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quarter" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"flagged" jsonb,
	"status" "access_review_status" DEFAULT 'draft' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anonymization_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" "anonymization_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "anonymization_status" DEFAULT 'submitted' NOT NULL,
	"approval_request_id" uuid,
	"blocked_reason" text,
	"executed_at" timestamp with time zone,
	"executed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"status" "approval_status" DEFAULT 'submitted' NOT NULL,
	"requester_user_id" uuid NOT NULL,
	"requester_role" "role_code",
	"approver_role" "role_code" DEFAULT 'owner' NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"amount" bigint,
	"reason" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"business_date" date,
	"deadline_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"delegation_id" uuid,
	"expired_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_sod_chk" CHECK ("approval_requests"."decided_by" is null or "approval_requests"."decided_by" <> "approval_requests"."requester_user_id")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"storage_key" text NOT NULL,
	"url" text,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text,
	"kind" text NOT NULL,
	"original_name" text,
	"object_type" text,
	"object_id" text,
	"captured_at" timestamp with time zone,
	"lat" double precision,
	"lng" double precision,
	"uploaded_by" uuid,
	"device_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"tenant_id" uuid,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"device_time" timestamp with time zone,
	"actor_user_id" uuid,
	"actor_employee_id" uuid,
	"actor_roles" "role_code"[],
	"actor_device_id" uuid,
	"actor_customer_account_id" uuid,
	"source" "actor_source" NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"rule" text,
	"business_date" date,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "audit_logs_seq_uq" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "backup_status_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "backup_kind" NOT NULL,
	"status" "backup_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"location" text,
	"rpo_minutes" integer,
	"rto_minutes" integer,
	"notes" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_signoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group" "data_signoff_group" NOT NULL,
	"title" text NOT NULL,
	"summary" jsonb NOT NULL,
	"status" "signoff_status" DEFAULT 'draft' NOT NULL,
	"import_batch_id" uuid,
	"signed_by" uuid,
	"signed_at" timestamp with time zone,
	"accountant_signed_by" uuid,
	"accountant_signed_at" timestamp with time zone,
	"attachment_id" uuid,
	"supersedes_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delegator_user_id" uuid NOT NULL,
	"delegate_user_id" uuid NOT NULL,
	"approval_type" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "delegations_valid_chk" CHECK ("delegations"."delegate_user_id" <> "delegations"."delegator_user_id" and "delegations"."valid_until" > "delegations"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "device_usage_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid,
	"event" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"app_version" text,
	"queue_count" integer,
	"battery_pct" smallint,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "device_kind" NOT NULL,
	"status" "device_status" DEFAULT 'registered' NOT NULL,
	"is_spare" boolean DEFAULT false NOT NULL,
	"holder_employee_id" uuid,
	"truck_id" uuid,
	"outlet_id" uuid,
	"water_source_id" uuid,
	"activation_code_hash" text,
	"activation_expires_at" timestamp with time zone,
	"secret_hash" text,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"app_version" text,
	"last_sync_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_user_id" uuid,
	"reported_queue_count" integer,
	"battery_pct" smallint,
	"blocked_at" timestamp with time zone,
	"blocked_by" uuid,
	"blocked_reason" text,
	"wipe_requested_at" timestamp with time zone,
	"wiped_at" timestamp with time zone,
	"vendor" text,
	"imei" text,
	"firmware_version" text,
	"gps_state" "gps_state",
	"gps_state_since" timestamp with time zone,
	"gps_last_position_at" timestamp with time zone,
	"gps_power_connected" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "devices_device_code_unique" UNIQUE("device_code")
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_key" text NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"tenant_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"business_date" date,
	"actor_user_id" uuid,
	"actor_customer_account_id" uuid,
	"source" "actor_source",
	"object_type" text,
	"object_id" text,
	CONSTRAINT "domain_events_seq_uq" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_no" text NOT NULL,
	"full_name" text NOT NULL,
	"nickname" text,
	"position" text NOT NULL,
	"phone" text,
	"work_location" text,
	"primary_outlet_id" uuid,
	"intended_roles" "role_code"[],
	"hire_date" date,
	"exit_date" date,
	"allow_bank_deposit" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "export_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"format" "export_format" NOT NULL,
	"filters" jsonb,
	"contains_personal_data" boolean DEFAULT false NOT NULL,
	"purpose" text,
	"row_count" integer,
	"file_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"scope_type" "feature_flag_scope" DEFAULT 'global' NOT NULL,
	"scope_ref_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"kind" "incident_kind" NOT NULL,
	"severity" "incident_severity" DEFAULT 'major' NOT NULL,
	"status" "incident_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"object_type" text,
	"object_id" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_key" text NOT NULL,
	"run_key" text NOT NULL,
	"status" "job_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"mode" "notification_mode" DEFAULT 'immediate' NOT NULL,
	"quiet_start" time,
	"quiet_end" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"severity" "notification_severity" DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"object_type" text,
	"object_id" text,
	"value_amount" bigint,
	"value_text" text,
	"deadline_at" timestamp with time zone,
	"link" text,
	"status" "notification_status" DEFAULT 'new' NOT NULL,
	"read_at" timestamp with time zone,
	"actioned_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"group_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "outlet_kind" NOT NULL,
	"address" text,
	"lat" double precision,
	"lng" double precision,
	"geofence_radius_m" integer,
	"storage_capacity_l" integer,
	"fixed_opening_cash" bigint,
	"qris_enabled" boolean DEFAULT true NOT NULL,
	"printer_enabled" boolean DEFAULT false NOT NULL,
	"default_operator_employee_id" uuid,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_on" date,
	"onboarding_completed_at" timestamp with time zone,
	"billing_start_date" date
);
--> statement-breakpoint
CREATE TABLE "parameters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"value" jsonb NOT NULL,
	"unit" text,
	"reference" text,
	"description" text,
	"effective_from" date NOT NULL,
	"tenant_id" uuid,
	"outlet_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"min_value" jsonb,
	"max_value" jsonb,
	"tenant_editable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pin_enrollments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text DEFAULT 'initial' NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"used_device_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "service_outages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"in_maintenance_window" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "session_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" uuid,
	"totp_verified_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" "ticket_category" DEFAULT 'app_issue' NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"device_id" uuid,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"app_version" text,
	"sync_status" jsonb,
	"status" "ticket_status" DEFAULT 'received' NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid,
	"device_id" uuid,
	"user_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"device_time" timestamp with time zone,
	"business_date" date,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "sync_command_status" NOT NULL,
	"result" jsonb,
	"message" text,
	"object_type" text,
	"object_id" text,
	"clock_skew_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "tenant_kind" DEFAULT 'owner' NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role_code" NOT NULL,
	"status" "grant_status" DEFAULT 'pending' NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"reason" text,
	"approval_request_id" uuid,
	"granted_by" uuid,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"ref_id" uuid NOT NULL,
	"status" "grant_status" DEFAULT 'pending' NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"reason" text,
	"approval_request_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"username" text NOT NULL,
	"password_hash" text,
	"password_changed_at" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"pin_hash" text,
	"pin_set_at" timestamp with time zone,
	"pin_failed_count" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_confirmed_at" timestamp with time zone,
	"totp_failed_count" integer DEFAULT 0 NOT NULL,
	"status" "user_status" DEFAULT 'pending_approval' NOT NULL,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"approval_request_id" uuid,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "users_employee_uq" UNIQUE("employee_id")
);
--> statement-breakpoint
CREATE TABLE "wa_message_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "wa_message_kind" NOT NULL,
	"template_id" uuid,
	"customer_id" uuid,
	"to_phone" text NOT NULL,
	"rendered_text" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"provider" "wa_provider" DEFAULT 'link' NOT NULL,
	"status" "wa_message_status" DEFAULT 'link_opened' NOT NULL,
	"opened_at" timestamp with time zone,
	"opened_by" uuid,
	"provider_message_id" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address_text" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"coordinate_status" "coordinate_status" DEFAULT 'unlocked' NOT NULL,
	"coordinate_source" "coordinate_source",
	"coordinate_locked_at" timestamp with time zone,
	"coordinate_locked_by" uuid,
	"proposed_lat" double precision,
	"proposed_lng" double precision,
	"proposed_from_trip_id" uuid,
	"proposed_at" timestamp with time zone,
	"notes" text,
	"tariff_zone_id" uuid,
	"zone_assignment" "zone_assignment" DEFAULT 'auto' NOT NULL,
	"zone_manual_reason" text,
	"zone_boundary_id" uuid,
	"zone_assigned_at" timestamp with time zone,
	"reference_water_source_id" uuid,
	"reference_source_manual" boolean DEFAULT false NOT NULL,
	"reference_source_reason" text,
	"distance_m" integer,
	"distance_method" "distance_method",
	"distance_needs_recalc" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "customer_credit_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"from_status" "credit_status",
	"to_status" "credit_status" NOT NULL,
	"credit_limit_before" bigint,
	"credit_limit_after" bigint,
	"term_days_before" integer,
	"term_days_after" integer,
	"reason" text,
	"changed_by" uuid,
	"rule" text,
	"approval_request_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_legacy_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid,
	"price_per_trip" bigint NOT NULL,
	"notes" text,
	"import_batch_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "customer_legacy_prices_price_chk" CHECK ("customer_legacy_prices"."price_per_trip" > 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"segment" "customer_segment" NOT NULL,
	"wa_phone" text NOT NULL,
	"contact_name" text,
	"notes" text,
	"fixed_receive_time" time,
	"credit_status" "credit_status" DEFAULT 'cash' NOT NULL,
	"credit_limit" bigint DEFAULT 0 NOT NULL,
	"credit_limit_overridden" boolean DEFAULT false NOT NULL,
	"payment_term_days" integer DEFAULT 14 NOT NULL,
	"monthly_billing" boolean DEFAULT false NOT NULL,
	"monthly_billing_agreement_attachment_id" uuid,
	"monthly_billing_approval_id" uuid,
	"is_store_partner" boolean DEFAULT false NOT NULL,
	"store_partner_source" "store_partner_source",
	"is_equa_partner" boolean DEFAULT false NOT NULL,
	"partner_tenant_id" uuid,
	"partner_outlet_id" uuid,
	"internal_outlet_id" uuid,
	"hold_deferral_until" date,
	"hold_deferral_reason" text,
	"hold_deferral_set_by" uuid,
	"hold_released_at" timestamp with time zone,
	"hold_released_by" uuid,
	"hold_release_approval_id" uuid,
	"hold_release_covers_due_until" date,
	"is_initial_data" boolean DEFAULT false NOT NULL,
	"import_batch_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "customers_household_cash_chk" CHECK ("customers"."segment" <> 'household' or ("customers"."credit_status" = 'cash' and "customers"."credit_limit" = 0 and "customers"."monthly_billing" = false)),
	CONSTRAINT "customers_credit_values_chk" CHECK ("customers"."credit_limit" >= 0 and "customers"."payment_term_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "depot_recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"material_product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fuel_components" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"amount_per_trip" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"is_owner_direct" boolean DEFAULT false NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "import_batch_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"data" jsonb NOT NULL,
	"status" "import_row_status" DEFAULT 'valid' NOT NULL,
	"errors" jsonb,
	"duplicate_candidates" jsonb,
	"merge_proposal" jsonb,
	"exclusion_reason" text,
	"created_entity_type" text,
	"created_entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "import_kind" NOT NULL,
	"file_attachment_id" uuid,
	"original_filename" text,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"is_initial_data" boolean DEFAULT false NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"excluded_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"signoff_id" uuid,
	"committed_at" timestamp with time zone,
	"committed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "pool_locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"geofence_radius_m" integer,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "price_kind" NOT NULL,
	"outlet_id" uuid,
	"price" bigint NOT NULL,
	"recommended_price" bigint,
	"effective_from" date NOT NULL,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"is_owner_direct" boolean DEFAULT false NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"line" "product_line" NOT NULL,
	"category" text,
	"unit" text NOT NULL,
	"is_internal_transfer" boolean DEFAULT false NOT NULL,
	"is_consumable" boolean DEFAULT false NOT NULL,
	"gallon_size_l" integer,
	"min_stock" integer,
	"barcode" text,
	"pos_visible" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"store_product_id" uuid,
	"source_product_id" uuid,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"approval_request_id" uuid,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "special_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"reason" text NOT NULL,
	"valid_from" date NOT NULL,
	"review_date" date NOT NULL,
	"valid_until" date,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"is_owner_direct" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tariff_zone_boundaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tariff_zone_id" uuid NOT NULL,
	"min_distance_m" integer NOT NULL,
	"max_distance_m" integer,
	"effective_from" date NOT NULL,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"is_owner_direct" boolean DEFAULT false NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "tariff_zone_boundaries_range_chk" CHECK ("tariff_zone_boundaries"."min_distance_m" >= 0 and ("tariff_zone_boundaries"."max_distance_m" is null or "tariff_zone_boundaries"."max_distance_m" > "tariff_zone_boundaries"."min_distance_m"))
);
--> statement-breakpoint
CREATE TABLE "tariff_zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"min_distance_m" integer NOT NULL,
	"max_distance_m" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "trucks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plate_number" text NOT NULL,
	"code" text NOT NULL,
	"capacity_l" integer DEFAULT 5000 NOT NULL,
	"status" "truck_status" DEFAULT 'active' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_reason" text,
	"default_driver_employee_id" uuid,
	"default_helper_employee_id" uuid,
	"gps_device_id" uuid,
	"field_device_id" uuid,
	"daily_trip_capacity" integer,
	"pool_location_id" uuid,
	"fleet_detection_enabled" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "trucks_plate_number_unique" UNIQUE("plate_number"),
	CONSTRAINT "trucks_default_driver_uq" UNIQUE("default_driver_employee_id"),
	CONSTRAINT "trucks_default_helper_uq" UNIQUE("default_helper_employee_id"),
	CONSTRAINT "trucks_gps_device_uq" UNIQUE("gps_device_id")
);
--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "wa_message_kind" NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "water_meters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"water_source_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"unit" "meter_unit" DEFAULT 'liter' NOT NULL,
	"initial_reading_l" bigint NOT NULL,
	"initial_photo_attachment_id" uuid,
	"installed_at" date,
	"status" "meter_status" DEFAULT 'active' NOT NULL,
	"replaced_by_meter_id" uuid,
	"replaced_at" timestamp with time zone,
	"final_reading_l" bigint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "water_meters_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "water_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"geofence_radius_m" integer,
	"daily_capacity_l" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "zone_tariffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tariff_zone_id" uuid NOT NULL,
	"segment" "customer_segment",
	"price_per_trip" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approval_request_id" uuid,
	"is_owner_direct" boolean DEFAULT false NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "crew_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"driver_employee_id" uuid NOT NULL,
	"source" "crew_assignment_source" NOT NULL,
	"reason" text,
	"assigned_by" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_rosters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "crew_roster_status" DEFAULT 'on_duty' NOT NULL,
	"truck_id" uuid,
	"role" "crew_role",
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "daily_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"truck_id" uuid NOT NULL,
	"status" "schedule_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"last_changed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "order_date_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"from_time" time,
	"to_time" time,
	"reason" text NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'new' NOT NULL,
	"source" "order_source" DEFAULT 'office' NOT NULL,
	"tank_count" integer DEFAULT 1 NOT NULL,
	"requested_date" date NOT NULL,
	"requested_time" time,
	"slot" "delivery_slot",
	"payment_method" "payment_method" DEFAULT 'cash' NOT NULL,
	"price_per_trip" bigint NOT NULL,
	"total_amount" bigint NOT NULL,
	"price_source" "order_price_source" NOT NULL,
	"tariff_zone_id" uuid,
	"zone_tariff_id" uuid,
	"fuel_component_id" uuid,
	"special_price_id" uuid,
	"price_is_provisional" boolean DEFAULT false NOT NULL,
	"price_updated_at" timestamp with time zone,
	"price_updated_by" uuid,
	"price_update_note" text,
	"notes" text,
	"is_internal" boolean DEFAULT false NOT NULL,
	"internal_outlet_id" uuid,
	"recurring_order_id" uuid,
	"after_cutoff_forced" boolean DEFAULT false NOT NULL,
	"after_cutoff_reason" text,
	"possible_duplicate" boolean DEFAULT false NOT NULL,
	"duplicate_of_order_id" uuid,
	"duplicate_reason" text,
	"collect_underpayment" boolean DEFAULT false NOT NULL,
	"needs_reschedule" boolean DEFAULT false NOT NULL,
	"reconfirmation_required" boolean DEFAULT false NOT NULL,
	"reconfirmed_at" timestamp with time zone,
	"reconfirmed_by" uuid,
	"reconfirmation_method" text,
	"credit_approval_request_id" uuid,
	"credit_exposure_at_decision" bigint,
	"credit_limit_at_decision" bigint,
	"sla_due_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"first_departed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancel_reason" "order_cancel_reason",
	"cancel_note" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"underpayment_approval_request_id" uuid,
	"created_by_customer_account_id" uuid,
	"cancelled_by_customer_account_id" uuid,
	CONSTRAINT "orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "recurring_order_failures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recurring_order_id" uuid NOT NULL,
	"target_date" date NOT NULL,
	"reason" "recurring_failure_reason" NOT NULL,
	"message" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"pattern" "recurring_pattern" NOT NULL,
	"days_of_week" smallint[],
	"interval_days" integer,
	"tank_count" integer DEFAULT 1 NOT NULL,
	"requested_time" time,
	"slot" "delivery_slot",
	"payment_method" "payment_method" DEFAULT 'cash' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"status" "recurring_status" DEFAULT 'active' NOT NULL,
	"last_generated_date" date,
	"created_via" "order_source" DEFAULT 'office' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "schedule_change_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid,
	"trip_id" uuid NOT NULL,
	"change_type" "schedule_change_type" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"after_publish" boolean DEFAULT false NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid,
	"truck_id" uuid,
	"kind" "trip_incident_kind" NOT NULL,
	"description" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"reported_by_user_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"truck_status_changed" boolean DEFAULT false NOT NULL,
	"business_date" date NOT NULL,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"status" "trip_status" NOT NULL,
	"device_time" timestamp with time zone,
	"business_date" date,
	"synced_at" timestamp with time zone,
	"lat" double precision,
	"lng" double precision,
	"accuracy_m" integer,
	"user_id" uuid,
	"device_id" uuid,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_status_events_sync_command_uq" UNIQUE("sync_command_id")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"number" text NOT NULL,
	"sequence_in_order" integer NOT NULL,
	"status" "trip_status" DEFAULT 'assigned' NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"destination_outlet_id" uuid,
	"truck_id" uuid,
	"scheduled_date" date NOT NULL,
	"schedule_id" uuid,
	"route_order" integer,
	"actual_order" integer,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"needs_reassignment" boolean DEFAULT false NOT NULL,
	"price" bigint NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"planned_volume_l" integer DEFAULT 5000 NOT NULL,
	"driver_user_id" uuid,
	"driver_employee_id" uuid,
	"helper_employee_id" uuid,
	"departed_at" timestamp with time zone,
	"departed_lat" double precision,
	"departed_lng" double precision,
	"departed_accuracy_m" integer,
	"arrived_at" timestamp with time zone,
	"arrived_lat" double precision,
	"arrived_lng" double precision,
	"arrived_accuracy_m" integer,
	"arrival_distance_m" integer,
	"no_location" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_lat" double precision,
	"completed_lng" double precision,
	"completed_accuracy_m" integer,
	"completion_distance_m" integer,
	"completion_distance_client_m" integer,
	"location_deviation" "location_deviation" DEFAULT 'none' NOT NULL,
	"location_reason" "location_reason",
	"location_reason_note" text,
	"owner_review_required" boolean DEFAULT false NOT NULL,
	"owner_reviewed_at" timestamp with time zone,
	"owner_reviewed_by" uuid,
	"owner_review_note" text,
	"delivered_volume_l" integer,
	"partial_volume_reason" "partial_volume_reason",
	"partial_volume_note" text,
	"recipient_name" text,
	"signature_attachment_id" uuid,
	"signature_skipped_reason" text,
	"receipt_skipped_reason" text,
	"failed_at" timestamp with time zone,
	"fail_reason" "trip_fail_reason",
	"fail_note" text,
	"fail_lat" double precision,
	"fail_lng" double precision,
	"loaded_water_disposition" "loaded_water_disposition",
	"sync_conflict" boolean DEFAULT false NOT NULL,
	"sync_conflict_note" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"completion_business_date" date,
	"sync_conflict_resolved_at" timestamp with time zone,
	"sync_conflict_resolved_by" uuid,
	"credit_hold_flagged_at" timestamp with time zone,
	"credit_hold_resolution" text,
	CONSTRAINT "trips_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "truck_day_status" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "truck_day_state" DEFAULT 'operating' NOT NULL,
	"trip_capacity" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "trip_expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid,
	"truck_id" uuid NOT NULL,
	"driver_user_id" uuid,
	"business_date" date NOT NULL,
	"kind" "trip_expense_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"receipt_attachment_id" uuid,
	"funding_source" "expense_funding_source" NOT NULL,
	"status" "expense_status" DEFAULT 'pending_verification' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"deposit_id" uuid,
	"reimbursed_at" timestamp with time zone,
	"office_cash_movement_id" uuid,
	"note" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid
);
--> statement-breakpoint
CREATE TABLE "trip_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"driver_user_id" uuid,
	"method" "payment_method" NOT NULL,
	"expected_amount" bigint NOT NULL,
	"received_amount" bigint NOT NULL,
	"underpayment_amount" bigint DEFAULT 0 NOT NULL,
	"underpayment_reason" text,
	"transfer_proof_attachment_id" uuid,
	"incoming_transfer_id" uuid,
	"invoice_id" uuid,
	"original_method" "payment_method",
	"method_change_approval_id" uuid,
	"deposit_id" uuid,
	"business_date" date NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	CONSTRAINT "trip_payments_amounts_chk" CHECK (("trip_payments"."reversal_of_id" is null and "trip_payments"."received_amount" >= 0 and "trip_payments"."underpayment_amount" >= 0 and ("trip_payments"."method" <> 'cash' or "trip_payments"."received_amount" + "trip_payments"."underpayment_amount" = "trip_payments"."expected_amount")) or ("trip_payments"."reversal_of_id" is not null and "trip_payments"."received_amount" <= 0 and "trip_payments"."underpayment_amount" <= 0 and "trip_payments"."expected_amount" <= 0))
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"account_name" text NOT NULL,
	"branch" text,
	"is_customer_facing" boolean DEFAULT false NOT NULL,
	"gl_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"business_date" date NOT NULL,
	"slip_attachment_id" uuid,
	"status" "bank_deposit_status" DEFAULT 'recorded' NOT NULL,
	"bank_statement_line_id" uuid,
	"matched_at" timestamp with time zone,
	"matched_by" uuid,
	"notes" text,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_attachment_id" uuid,
	"original_filename" text,
	"period_start" date,
	"period_end" date,
	"line_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"import_id" uuid,
	"bank_account_id" uuid NOT NULL,
	"line_date" date NOT NULL,
	"description" text,
	"amount" bigint NOT NULL,
	"balance" bigint,
	"reference" text,
	"row_hash" text NOT NULL,
	"status" "bank_statement_line_status" DEFAULT 'unmatched' NOT NULL,
	"matched_by" uuid,
	"matched_at" timestamp with time zone,
	"follow_up_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_close_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cash_day_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"source_type" "deposit_source_type" NOT NULL,
	"deposit_id" uuid,
	"employee_id" uuid,
	"outlet_id" uuid,
	"reason" text NOT NULL,
	"status" "cash_close_exception_status" DEFAULT 'submitted' NOT NULL,
	"approval_request_id" uuid,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"converted_discrepancy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "cash_days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "cash_day_status" DEFAULT 'open' NOT NULL,
	"last_deposit_received_at" timestamp with time zone,
	"close_started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_late" boolean DEFAULT false NOT NULL,
	"office_cash_system" bigint,
	"office_cash_physical" bigint,
	"office_cash_difference" bigint,
	"office_cash_reason" text,
	"office_discrepancy_id" uuid,
	"blockers_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"source_type" "deposit_source_type" NOT NULL,
	"business_date" date NOT NULL,
	"status" "deposit_status" DEFAULT 'running' NOT NULL,
	"depositor_user_id" uuid,
	"depositor_employee_id" uuid,
	"truck_id" uuid,
	"outlet_id" uuid,
	"shift_id" uuid,
	"method" "deposit_method" DEFAULT 'physical' NOT NULL,
	"bank_slip_attachment_id" uuid,
	"slip_transfer_id" uuid,
	"expected_cash" bigint DEFAULT 0 NOT NULL,
	"accepted_expenses" bigint DEFAULT 0 NOT NULL,
	"expected_net" bigint DEFAULT 0 NOT NULL,
	"received_amount" bigint,
	"discrepancy_amount" bigint,
	"discrepancy_reason" "discrepancy_reason",
	"discrepancy_note" text,
	"denominations" jsonb,
	"summary_snapshot" jsonb,
	"submitted_at" timestamp with time zone,
	"submitted_late" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"received_late" boolean DEFAULT false NOT NULL,
	"late_reason" text,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"depositor_note" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"is_partial" boolean DEFAULT false NOT NULL,
	"carry_over_cash" bigint DEFAULT 0 NOT NULL,
	"receipt_snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" "discrepancy_source" NOT NULL,
	"deposit_id" uuid,
	"employee_id" uuid,
	"user_id" uuid,
	"truck_id" uuid,
	"outlet_id" uuid,
	"shift_id" uuid,
	"business_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"status" "discrepancy_status" DEFAULT 'formed' NOT NULL,
	"reason" "discrepancy_reason",
	"reason_note" text,
	"explanation" text,
	"explained_by" uuid,
	"explained_at" timestamp with time zone,
	"requires_owner_decision" boolean DEFAULT false NOT NULL,
	"approval_request_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"closed_below_threshold_by" uuid,
	"closed_below_threshold_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"followed_up_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"locks_trips" boolean DEFAULT false NOT NULL,
	"evidence_attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"decision" "discrepancy_decision",
	"follow_up_note" text,
	"followed_up_by" uuid
);
--> statement-breakpoint
CREATE TABLE "incoming_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_kind" "transfer_source_kind" NOT NULL,
	"source_object_type" text,
	"source_object_id" uuid,
	"customer_id" uuid,
	"outlet_id" uuid,
	"shift_id" uuid,
	"amount" bigint NOT NULL,
	"transfer_date" date NOT NULL,
	"business_date" date NOT NULL,
	"proof_attachment_id" uuid,
	"bank_account_id" uuid,
	"reference" text,
	"status" "incoming_transfer_status" DEFAULT 'unmatched' NOT NULL,
	"matched_at" timestamp with time zone,
	"matched_by" uuid,
	"match_ref_date" date,
	"match_ref_amount" bigint,
	"match_ref_note" text,
	"bank_statement_line_id" uuid,
	"not_found_at" timestamp with time zone,
	"temporary_invoice_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"source_user_id" uuid,
	"truck_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "office_cash_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" "office_cash_kind" NOT NULL,
	"direction" "cash_direction" NOT NULL,
	"amount" bigint NOT NULL,
	"source_object_type" text,
	"source_object_id" uuid,
	"description" text,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "petty_cash_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_date" date NOT NULL,
	"system_balance" bigint NOT NULL,
	"physical_amount" bigint NOT NULL,
	"difference" bigint NOT NULL,
	"reason" text,
	"discrepancy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "petty_cash_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" "petty_cash_kind" NOT NULL,
	"amount" bigint NOT NULL,
	"category" text,
	"profit_center" "profit_center",
	"outlet_id" uuid,
	"description" text,
	"receipt_attachment_id" uuid,
	"status" "petty_cash_status" DEFAULT 'approved' NOT NULL,
	"approval_request_id" uuid,
	"office_cash_movement_id" uuid,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "restitution_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"restitution_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"method" "restitution_settlement_method" NOT NULL,
	"settled_on" date NOT NULL,
	"reference" text,
	"office_cash_movement_id" uuid,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "restitutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"discrepancy_id" uuid,
	"business_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"trip_id" uuid,
	"shift_id" uuid,
	"reason" text NOT NULL,
	"status" "restitution_status" DEFAULT 'recorded' NOT NULL,
	"settled_amount" bigint DEFAULT 0 NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"issue_date" date NOT NULL,
	"status" "credit_note_status" DEFAULT 'issued' NOT NULL,
	"approval_request_id" uuid,
	"pos_sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "credit_notes_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "customer_advances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_payment_id" uuid,
	"order_id" uuid,
	"amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"status" "advance_status" DEFAULT 'open' NOT NULL,
	"refund_approval_id" uuid,
	"refunded_at" timestamp with time zone,
	"refunded_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" "payment_channel" NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount" bigint NOT NULL,
	"business_date" date NOT NULL,
	"proof_attachment_id" uuid,
	"incoming_transfer_id" uuid,
	"trip_id" uuid,
	"driver_user_id" uuid,
	"deposit_id" uuid,
	"payment_intent_id" uuid,
	"office_cash_movement_id" uuid,
	"advance_amount" bigint DEFAULT 0 NOT NULL,
	"notes" text,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"component" "invoice_line_component" NOT NULL,
	"description" text NOT NULL,
	"trip_id" uuid,
	"pos_sale_line_id" uuid,
	"product_id" uuid,
	"service_date" date,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"volume_l" integer,
	"unbilled_charge_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_id" uuid,
	"trip_id" uuid,
	"pos_sale_id" uuid,
	"period_month" date,
	"partner_contract_id" uuid,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"credited_amount" bigint DEFAULT 0 NOT NULL,
	"outstanding_amount" bigint NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"description" text,
	"is_opening_balance" boolean DEFAULT false NOT NULL,
	"opening_confirmation_attachment_id" uuid,
	"opening_line" "receivable_line",
	"dispute_status" "dispute_status" DEFAULT 'none' NOT NULL,
	"disputed_at" timestamp with time zone,
	"dispute_note" text,
	"dispute_until" date,
	"dispute_decided_at" timestamp with time zone,
	"dispute_decided_by" uuid,
	"pdf_attachment_id" uuid,
	"sent_at" timestamp with time zone,
	"sent_via" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"pending_transfer_id" uuid,
	"written_off_amount" bigint DEFAULT 0 NOT NULL,
	"written_off_at" timestamp with time zone,
	"write_off_journal_id" uuid,
	"write_off_approval_id" uuid,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_outstanding_chk" CHECK ("invoices"."outstanding_amount" = "invoices"."amount" - "invoices"."paid_amount" - "invoices"."credited_amount" - "invoices"."written_off_amount" and "invoices"."outstanding_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_payment_id" uuid,
	"customer_advance_id" uuid,
	"credit_note_id" uuid,
	"amount" bigint NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payment_allocations_one_source_chk" CHECK (num_nonnulls("payment_allocations"."customer_payment_id", "payment_allocations"."customer_advance_id", "payment_allocations"."credit_note_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "receivable_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"kind" "reminder_kind" NOT NULL,
	"scheduled_date" date NOT NULL,
	"total_outstanding" bigint NOT NULL,
	"status" "reminder_status" DEFAULT 'scheduled' NOT NULL,
	"opened_at" timestamp with time zone,
	"opened_by" uuid,
	"wa_message_log_id" uuid,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unbilled_charges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"trip_id" uuid,
	"pos_sale_id" uuid,
	"service_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"volume_l" integer,
	"status" "unbilled_status" DEFAULT 'unbilled' NOT NULL,
	"invoice_id" uuid,
	"late_sync" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumable_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" bigint,
	"expected_quantity" integer,
	"difference_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumable_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source" "consumable_source" NOT NULL,
	"internal_transfer_id" uuid,
	"supplier_id" uuid,
	"supplier_note_number" text,
	"note_attachment_id" uuid,
	"shift_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"received_by" uuid,
	"business_date" date NOT NULL,
	"notes" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	"reversed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outlet_water_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" "outlet_water_kind" NOT NULL,
	"volume_l" integer NOT NULL,
	"balance_after_l" integer,
	"source_object_type" text,
	"source_object_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pos_sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pos_sale_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"product_price_id" uuid,
	"quantity" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"line_total" bigint NOT NULL,
	"unit_cost" bigint,
	"gallon_size_l" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"number" text,
	"local_number" text NOT NULL,
	"device_seq" integer NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"customer_id" uuid,
	"price_kind" "price_kind" NOT NULL,
	"business_date" date NOT NULL,
	"sold_at" timestamp with time zone NOT NULL,
	"subtotal" bigint NOT NULL,
	"discount_percent" numeric(5, 2),
	"discount_amount" bigint DEFAULT 0 NOT NULL,
	"discount_reason" text,
	"discount_approval_id" uuid,
	"total" bigint NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"cash_received" bigint,
	"change_amount" bigint,
	"qris_reference" text,
	"invoice_id" uuid,
	"status" "pos_sale_status" DEFAULT 'valid' NOT NULL,
	"void_reason" "void_reason",
	"void_note" text,
	"void_requested_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_approval_id" uuid,
	"replaces_sale_id" uuid,
	"price_mismatch" boolean DEFAULT false NOT NULL,
	"credit_offline" boolean DEFAULT false NOT NULL,
	"receipt_printed" boolean DEFAULT false NOT NULL,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"is_reversal" boolean DEFAULT false NOT NULL,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	CONSTRAINT "pos_sales_reversal_chk" CHECK (("pos_sales"."is_reversal" = false and "pos_sales"."reversal_of_id" is null and "pos_sales"."total" >= 0) or ("pos_sales"."is_reversal" = true and "pos_sales"."reversal_of_id" is not null and "pos_sales"."total" <= 0))
);
--> statement-breakpoint
CREATE TABLE "shift_stock_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"phase" "shift_stock_phase" NOT NULL,
	"system_qty" integer NOT NULL,
	"physical_qty" integer,
	"expected_usage" integer,
	"difference" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"operator_user_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "shift_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_cash_fixed" bigint NOT NULL,
	"opening_cash_counted" bigint,
	"closed_at" timestamp with time zone,
	"cash_sales" bigint,
	"qris_sales" bigint,
	"credit_sales" bigint,
	"void_count" integer,
	"void_amount" bigint,
	"expected_cash" bigint,
	"closing_cash_counted" bigint,
	"cash_difference" bigint,
	"cash_difference_reason" text,
	"deposit_amount" bigint,
	"deposit_status" "shift_deposit_status" DEFAULT 'not_deposited' NOT NULL,
	"deposit_id" uuid,
	"deposited_at" timestamp with time zone,
	"cash_limit_alert_at" timestamp with time zone,
	"summary" jsonb,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"partial_deposit_total" bigint DEFAULT 0 NOT NULL,
	"sync_conflict" boolean DEFAULT false NOT NULL,
	"sync_conflict_note" text,
	"conflict_resolved_at" timestamp with time zone,
	"conflict_resolved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"avg_cost" bigint DEFAULT 0 NOT NULL,
	"total_value" bigint DEFAULT 0 NOT NULL,
	"last_movement_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"physical_qty" integer NOT NULL,
	"system_qty_at_count" integer NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	"difference_qty" integer NOT NULL,
	"unit_cost" bigint,
	"difference_value" bigint,
	"reason" "stock_adjust_reason",
	"reason_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"kind" "stock_count_kind" NOT NULL,
	"period_label" text NOT NULL,
	"status" "stock_count_status" DEFAULT 'counting' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"counted_by" uuid,
	"co_counter_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approval_request_id" uuid,
	"decided_at" timestamp with time zone,
	"adjustment_posted_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"notes" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "stock_movement_kind" NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" bigint,
	"total_cost" bigint,
	"balance_after" integer NOT NULL,
	"avg_cost_after" bigint,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_object_type" text,
	"source_object_id" uuid,
	"reversal_of_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "water_supply_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"source" "water_supply_source" DEFAULT 'equa_truck' NOT NULL,
	"trip_id" uuid,
	"status" "water_supply_status" DEFAULT 'arrived' NOT NULL,
	"delivered_volume_l" integer,
	"received_volume_l" integer,
	"difference_l" integer,
	"difference_reason" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"shift_id" uuid,
	"auto_accepted_at" timestamp with time zone,
	"other_source_reason" text,
	"business_date" date NOT NULL,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	"reversed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "internal_transfer_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"to_product_id" uuid,
	"quantity_sent" integer NOT NULL,
	"quantity_received" integer,
	"unit_value" bigint NOT NULL,
	"unit_cost" bigint,
	"line_value" bigint NOT NULL,
	"difference_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "internal_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text,
	"local_number" text,
	"device_seq" integer,
	"from_outlet_id" uuid NOT NULL,
	"to_outlet_id" uuid NOT NULL,
	"status" "internal_transfer_status" DEFAULT 'sent' NOT NULL,
	"business_date" date NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by" uuid,
	"received_at" timestamp with time zone,
	"received_by" uuid,
	"total_value" bigint NOT NULL,
	"has_difference" boolean DEFAULT false NOT NULL,
	"notes" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid,
	CONSTRAINT "internal_transfers_number_chk" CHECK (("internal_transfers"."number" is not null or "internal_transfers"."local_number" is not null) and ("internal_transfers"."device_id" is null or ("internal_transfers"."local_number" is not null and "internal_transfers"."device_seq" is not null)))
);
--> statement-breakpoint
CREATE TABLE "purchase_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" bigint NOT NULL,
	"line_total" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"number" text,
	"local_number" text,
	"device_seq" integer,
	"supplier_id" uuid NOT NULL,
	"supplier_note_number" text,
	"supplier_note_date" date,
	"note_attachment_id" uuid,
	"is_substitute_note" boolean DEFAULT false NOT NULL,
	"substitute_goods_photo_id" uuid,
	"substitute_accepted_by" uuid,
	"substitute_accepted_at" timestamp with time zone,
	"status" "purchase_receipt_status" DEFAULT 'received' NOT NULL,
	"total_amount" bigint NOT NULL,
	"payment_status" "payable_status" DEFAULT 'unpaid' NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"due_date" date,
	"paid_on_receipt_method" "payment_method",
	"is_opening_payable" boolean DEFAULT false NOT NULL,
	"received_by" uuid,
	"business_date" date NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"notes" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "purchase_receipts_number_chk" CHECK (("purchase_receipts"."number" is not null or "purchase_receipts"."local_number" is not null) and ("purchase_receipts"."device_id" is null or ("purchase_receipts"."local_number" is not null and "purchase_receipts"."device_seq" is not null)))
);
--> statement-breakpoint
CREATE TABLE "reorder_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "reorder_status" DEFAULT 'open' NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"balance_at_trigger" integer NOT NULL,
	"last_supplier_id" uuid,
	"ordered_at" timestamp with time zone,
	"ordered_supplier_id" uuid,
	"ordered_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_payment_id" uuid NOT NULL,
	"purchase_receipt_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"correction_approval_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"amount" bigint NOT NULL,
	"method" "payment_method" NOT NULL,
	"proof_attachment_id" uuid,
	"bank_account_id" uuid,
	"office_cash_movement_id" uuid,
	"notes" text,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"address" text,
	"payment_term_days" integer,
	"status" "supplier_status" DEFAULT 'pending_approval' NOT NULL,
	"approval_request_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "daily_productions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"produced_l" bigint,
	"status" "production_status" DEFAULT 'incomplete' NOT NULL,
	"incomplete_reason" text,
	"detail" jsonb,
	"deviation_pct" numeric(7, 2),
	"flagged_for_verification" boolean DEFAULT false NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_adjustments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"water_meter_id" uuid NOT NULL,
	"kind" "meter_adjustment_kind" NOT NULL,
	"business_date" date NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"previous_reading_id" uuid,
	"previous_reading_l" bigint,
	"rollover_at_l" bigint,
	"final_reading_l" bigint,
	"new_meter_id" uuid,
	"new_initial_reading_l" bigint,
	"applied_reading_id" uuid,
	"reason" text NOT NULL,
	"photo_attachment_id" uuid,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"water_meter_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"phase" "meter_phase" NOT NULL,
	"reading_l" bigint NOT NULL,
	"photo_attachment_id" uuid,
	"read_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"status" "meter_reading_status" DEFAULT 'recorded' NOT NULL,
	"anomaly_note" text,
	"adjustment_kind" "meter_adjustment_kind",
	"adjustment_reason" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"superseded_by_id" uuid,
	"correction_reason" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"late_reason" text,
	"adjustment_id" uuid
);
--> statement-breakpoint
CREATE TABLE "quality_test_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_type" "quality_location_type" NOT NULL,
	"water_source_id" uuid,
	"outlet_id" uuid,
	"frequency_days" integer,
	"next_due_date" date,
	"laboratory" text,
	"parameters" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "quality_tests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"schedule_id" uuid,
	"location_type" "quality_location_type" NOT NULL,
	"water_source_id" uuid,
	"outlet_id" uuid,
	"test_date" date NOT NULL,
	"laboratory" text,
	"results" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"certificate_attachment_id" uuid,
	"action_required" text,
	"action_owner_employee_id" uuid,
	"action_due_date" date,
	"action_done_at" timestamp with time zone,
	"action_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"action_done_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tank_level_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"level_l" integer,
	"level_pct" numeric(7, 2),
	"read_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"photo_attachment_id" uuid,
	"notes" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truck_fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"trip_id" uuid,
	"business_date" date NOT NULL,
	"volume_l" integer NOT NULL,
	"volume_reason" text,
	"filled_at" timestamp with time zone NOT NULL,
	"recorded_by" uuid,
	"photo_attachment_id" uuid,
	"status" "truck_fill_status" DEFAULT 'recorded' NOT NULL,
	"is_depot_supply" boolean DEFAULT false NOT NULL,
	"unplanned_truck" boolean DEFAULT false NOT NULL,
	"geofence_mismatch" boolean DEFAULT false NOT NULL,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"requested_trip_id" uuid,
	"sync_conflict_note" text
);
--> statement-breakpoint
CREATE TABLE "water_balances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"water_source_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"produced_l" bigint,
	"filled_customer_l" integer DEFAULT 0 NOT NULL,
	"filled_depot_l" integer DEFAULT 0 NOT NULL,
	"filled_total_l" integer DEFAULT 0 NOT NULL,
	"loss_l" bigint,
	"loss_pct" numeric(7, 2),
	"avg_loss_7d_pct" numeric(7, 2),
	"utilization_pct" numeric(7, 2),
	"is_incomplete" boolean DEFAULT false NOT NULL,
	"status" "water_balance_status" DEFAULT 'formed' NOT NULL,
	"investigation_reason" "loss_reason",
	"investigation_note" text,
	"investigation_photo_id" uuid,
	"investigated_by" uuid,
	"investigated_at" timestamp with time zone,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"returned_l" integer,
	"verification_note" text,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE "daily_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" "daily_summary_status" DEFAULT 'running' NOT NULL,
	"cash_day_id" uuid,
	"snapshot" jsonb,
	"cash_closed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_late" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_summary_addenda" (
	"id" uuid PRIMARY KEY NOT NULL,
	"daily_summary_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"kind" "summary_addendum_kind" NOT NULL,
	"object_type" text,
	"object_id" text,
	"description" text NOT NULL,
	"delta" jsonb,
	"recorded_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_manual_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kpi_code" text NOT NULL,
	"period" text NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "parallel_run_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"unit_type" "unit_type" NOT NULL,
	"truck_id" uuid,
	"outlet_id" uuid,
	"business_date" date NOT NULL,
	"paper_count" integer NOT NULL,
	"paper_amount" bigint NOT NULL,
	"system_count" integer NOT NULL,
	"system_amount" bigint NOT NULL,
	"difference_count" integer NOT NULL,
	"difference_amount" bigint NOT NULL,
	"explained" boolean DEFAULT true NOT NULL,
	"cause" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"report_key" text NOT NULL,
	"period" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" "report_status" DEFAULT 'provisional' NOT NULL,
	"scope_key" text DEFAULT '' NOT NULL,
	"filters" jsonb,
	"data" jsonb NOT NULL,
	"file_sha256" text,
	"accounting_period_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" uuid,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_paper_withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"unit_type" "unit_type" NOT NULL,
	"truck_id" uuid,
	"outlet_id" uuid,
	"parallel_start_date" date NOT NULL,
	"withdrawn_date" date,
	"early_withdrawal_approved_by" uuid,
	"extension_days" integer DEFAULT 0 NOT NULL,
	"extension_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_late" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopen_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"manual_review_marked_at" timestamp with time zone,
	"manual_review_marked_by" uuid,
	"prerequisites_snapshot" jsonb,
	"accountant_review_note" text,
	"is_retroactive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"normal_balance" "normal_balance" NOT NULL,
	"parent_id" uuid,
	"is_postable" boolean DEFAULT true NOT NULL,
	"profit_center" "profit_center",
	"is_internal_transfer" boolean DEFAULT false NOT NULL,
	"is_cash" boolean DEFAULT false NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"statement_balance" bigint NOT NULL,
	"book_balance" bigint NOT NULL,
	"adjusting_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"difference" bigint NOT NULL,
	"status" "reconciliation_status" DEFAULT 'in_progress' NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"kind" "cash_reconciliation_kind" NOT NULL,
	"outlet_id" uuid,
	"employee_id" uuid,
	"system_balance" bigint NOT NULL,
	"physical_balance" bigint NOT NULL,
	"difference" bigint NOT NULL,
	"reason" text,
	"discrepancy_id" uuid,
	"status" "reconciliation_status" DEFAULT 'in_progress' NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_allocation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"kind" "allocation_kind" NOT NULL,
	"basis" jsonb NOT NULL,
	"total_amount" bigint NOT NULL,
	"result" jsonb,
	"journal_id" uuid,
	"status" "allocation_status" DEFAULT 'draft' NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"accumulated_after" bigint NOT NULL,
	"book_value_after" bigint NOT NULL,
	"journal_id" uuid,
	"is_adjustment" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_account_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"entry_key" text NOT NULL,
	"description" text NOT NULL,
	"debit_account_id" uuid NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"debit_profit_center" "profit_center",
	"credit_profit_center" "profit_center",
	"profit_center_rule" text DEFAULT 'fixed' NOT NULL,
	"effective_from" date NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "export_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"format" "export_format" DEFAULT 'xlsx' NOT NULL,
	"column_mapping" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_extras" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fixed_asset_id" uuid NOT NULL,
	"opening_accumulated" bigint DEFAULT 0 NOT NULL,
	"acquisition_journal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "asset_category" NOT NULL,
	"acquisition_date" date NOT NULL,
	"acquisition_cost" bigint NOT NULL,
	"residual_value" bigint DEFAULT 0 NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" "depreciation_method" DEFAULT 'straight_line' NOT NULL,
	"profit_center" "profit_center" NOT NULL,
	"outlet_id" uuid,
	"truck_id" uuid,
	"water_source_id" uuid,
	"asset_account_id" uuid,
	"accumulated_account_id" uuid,
	"expense_account_id" uuid,
	"status" "asset_status" DEFAULT 'active' NOT NULL,
	"disposed_at" date,
	"disposal_proceeds" bigint,
	"disposal_gain_loss" bigint,
	"disposal_journal_id" uuid,
	"source" text DEFAULT 'import' NOT NULL,
	"signoff_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"profit_center" "profit_center" NOT NULL,
	"outlet_id" uuid,
	"truck_id" uuid,
	"water_source_id" uuid,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_amount_chk" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and ("journal_lines"."debit" = 0 or "journal_lines"."credit" = 0) and ("journal_lines"."debit" + "journal_lines"."credit") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_payable_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payable_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_payables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"supplier_id" uuid,
	"payee_name" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"due_date" date NOT NULL,
	"settled_amount" bigint DEFAULT 0 NOT NULL,
	"status" "journal_payable_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "journal_payables_amount_chk" CHECK ("journal_payables"."amount" > 0 and "journal_payables"."settled_amount" >= 0 and "journal_payables"."settled_amount" <= "journal_payables"."amount")
);
--> statement-breakpoint
CREATE TABLE "journal_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"domain_event_id" uuid,
	"source_object_type" text,
	"source_object_id" uuid,
	"payload" jsonb NOT NULL,
	"journal_date" date NOT NULL,
	"reason" "journal_queue_reason" NOT NULL,
	"message" text,
	"status" "journal_queue_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"resolved_journal_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "journal_kind" NOT NULL,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"journal_date" date NOT NULL,
	"period_id" uuid,
	"origin_period" text,
	"description" text NOT NULL,
	"source_type" text,
	"source_object_type" text,
	"source_object_id" uuid,
	"source_event_id" uuid,
	"total_debit" bigint DEFAULT 0 NOT NULL,
	"total_credit" bigint DEFAULT 0 NOT NULL,
	"attachment_id" uuid,
	"approval_request_id" uuid,
	"requires_owner_review" boolean DEFAULT false NOT NULL,
	"owner_reviewed_at" timestamp with time zone,
	"owner_reviewed_by" uuid,
	"reversal_of_id" uuid,
	"reversal_reason" text,
	"auto_reverse_on" date,
	"template_key" text,
	"is_retroactive" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "journals_posted_period_chk" CHECK ("journals"."status" <> 'posted' or "journals"."period_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "manual_journal_details" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"recurring_journal_id" uuid,
	"recurring_period" text,
	"payable" jsonb,
	"settles_payable_id" uuid,
	"write_off" jsonb,
	"accountant_note" text,
	"asset_disposal" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_balance_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group" "opening_batch_group" NOT NULL,
	"cutover_date" date NOT NULL,
	"status" "opening_batch_status" DEFAULT 'draft' NOT NULL,
	"signoff_id" uuid,
	"accountant_approved_by" uuid,
	"accountant_approved_at" timestamp with time zone,
	"journal_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "opening_balance_batches_first_day_chk" CHECK (extract(day from "opening_balance_batches"."cutover_date") = 1)
);
--> statement-breakpoint
CREATE TABLE "opening_balance_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"profit_center" "profit_center" NOT NULL,
	"outlet_id" uuid,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"description" text,
	"reference_type" text,
	"reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "period_review_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"kind" "period_review_kind" DEFAULT 'review' NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "profit_centers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" "profit_center" NOT NULL,
	"name" text NOT NULL,
	"is_cost_center" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template" "recurring_journal_template" NOT NULL,
	"description" text NOT NULL,
	"lines" jsonb NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"is_accrual" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_generated_period" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "recurring_journals_day_chk" CHECK ("recurring_journals"."day_of_month" between 1 and 28)
);
--> statement-breakpoint
CREATE TABLE "retroactive_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"events_scanned" integer DEFAULT 0 NOT NULL,
	"posted" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"queued" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"verification_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_scheme_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tax_setting_id" uuid NOT NULL,
	"rate_percent" numeric(7, 2) NOT NULL,
	"basis" text DEFAULT 'gross_revenue' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scheme" "tax_scheme" DEFAULT 'non_pkp_final' NOT NULL,
	"is_pkp" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "fleet_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "fleet_event_kind" NOT NULL,
	"status" "fleet_event_status" DEFAULT 'detected' NOT NULL,
	"truck_id" uuid,
	"trip_id" uuid,
	"device_id" uuid,
	"user_id" uuid,
	"business_date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_s" integer,
	"distance_m" integer,
	"lat" double precision,
	"lng" double precision,
	"location_type" "geofence_location_type",
	"location_id" uuid,
	"details" jsonb,
	"requires_explanation" boolean DEFAULT false NOT NULL,
	"explanation" text,
	"explained_by" uuid,
	"explained_at" timestamp with time zone,
	"explanation_device_time" timestamp with time zone,
	"explanation_device_id" uuid,
	"explanation_sync_command_id" uuid,
	"explanation_business_date" date,
	"explanation_late" boolean DEFAULT false NOT NULL,
	"review_decision" "fleet_review_decision",
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE TABLE "fuel_estimates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"distance_m" integer NOT NULL,
	"consumption_l_per_km" numeric(8, 4) NOT NULL,
	"fuel_price_per_l" bigint NOT NULL,
	"estimated_cost" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fuel_estimates_trip_uq" UNIQUE("trip_id")
);
--> statement-breakpoint
CREATE TABLE "gps_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"device_id" uuid,
	"source" "position_source" NOT NULL,
	"device_time" timestamp with time zone NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"speed_kmh" real,
	"heading" smallint,
	"accuracy_m" real,
	"ignition_on" boolean,
	"power_connected" boolean,
	"is_valid" boolean DEFAULT true NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"trip_id" uuid,
	"user_id" uuid,
	"vendor" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "phone_tracking_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"truck_id" uuid NOT NULL,
	"reason" "phone_tracking_reason" NOT NULL,
	"set_by" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"fleet_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"truck_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"distance_m" integer,
	"duration_s" integer,
	"stops" jsonb,
	"time_at_customer_s" integer,
	"path" jsonb,
	"is_estimated" boolean DEFAULT false NOT NULL,
	"has_gaps" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_tracks_trip_uq" UNIQUE("trip_id")
);
--> statement-breakpoint
CREATE TABLE "truck_day_summaries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"truck_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"distance_m" integer,
	"moving_s" integer,
	"stopped_s" integer,
	"first_move_at" timestamp with time zone,
	"last_move_at" timestamp with time zone,
	"trip_count" integer,
	"between_trip_distance_m" integer,
	"gps_dead_minutes" integer,
	"is_estimated" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaint_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"complaint_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"visible_to_customer" boolean DEFAULT true NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_account_id" uuid,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"trip_id" uuid,
	"invoice_id" uuid,
	"kind" "complaint_kind" NOT NULL,
	"description" text NOT NULL,
	"photo_attachment_id" uuid,
	"status" "complaint_status" DEFAULT 'submitted' NOT NULL,
	"assigned_role" text NOT NULL,
	"due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"first_response_by" uuid,
	"response" text,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_account_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"detail" text,
	"candidate_customer_id" uuid,
	"handled_at" timestamp with time zone,
	"handled_by" uuid,
	"handled_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"customer_id" uuid,
	"status" "customer_account_status" DEFAULT 'registered' NOT NULL,
	"display_name" text,
	"verified_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"linked_by" uuid,
	"consent_pdp_at" timestamp with time zone,
	"consent_version" text,
	"last_login_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_accounts_phone_uq" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "customer_app_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"slot" text,
	"payment_preference" text DEFAULT 'cash' NOT NULL,
	"client_request_id" uuid,
	"confirm_due_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"reject_reason" text,
	"cancelled_by_customer_at" timestamp with time zone,
	"cancel_reason" text,
	"overdue_notified_at" timestamp with time zone,
	"prepaid_at" timestamp with time zone,
	"prepaid_amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_app_orders_order_uq" UNIQUE("order_id"),
	CONSTRAINT "customer_app_orders_client_request_uq" UNIQUE("client_request_id")
);
--> statement-breakpoint
CREATE TABLE "customer_download_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_account_id" uuid,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"object_type" text,
	"object_id" text,
	"dedupe_key" text NOT NULL,
	"push_sent_at" timestamp with time zone,
	"wa_message_log_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notifications_dedupe_uq" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "customer_push_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_push_subscriptions_endpoint_uq" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reverified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"purpose" "otp_purpose" NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"consumed_at" timestamp with time zone,
	"customer_account_id" uuid,
	"wa_message_log_id" uuid,
	"request_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_account_id" uuid,
	"invoice_id" uuid,
	"order_id" uuid,
	"amount" bigint NOT NULL,
	"gateway" text DEFAULT 'midtrans' NOT NULL,
	"method" "payment_intent_method" NOT NULL,
	"status" "payment_intent_status" DEFAULT 'pending' NOT NULL,
	"gateway_order_id" text NOT NULL,
	"gateway_transaction_id" text,
	"qr_string" text,
	"va_number" text,
	"va_bank" text,
	"expires_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"gateway_fee" bigint,
	"last_notification" jsonb,
	"customer_payment_id" uuid,
	"incoming_transfer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_gateway_order_uq" UNIQUE("gateway_order_id")
);
--> statement-breakpoint
CREATE TABLE "phone_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"old_phone" text NOT NULL,
	"new_phone" text NOT NULL,
	"old_verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refill_reminder_prefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"avg_interval_days" integer,
	"next_reminder_date" date,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refill_reminder_prefs_account_uq" UNIQUE("customer_account_id")
);
--> statement-breakpoint
CREATE TABLE "trip_ratings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"truck_id" uuid,
	"driver_employee_id" uuid,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_ratings_trip_uq" UNIQUE("trip_id"),
	CONSTRAINT "trip_ratings_rating_chk" CHECK ("trip_ratings"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "wa_message_costs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_message_log_id" uuid,
	"provider_message_id" text NOT NULL,
	"category" text NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"cost_amount" bigint NOT NULL,
	"month" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_message_costs_provider_uq" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "exclusive_territories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"outlet_id" uuid,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"radius_m" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_checklists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contract_id" uuid NOT NULL,
	"outlet_id" uuid,
	"item" "onboarding_item" NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"evidence_attachment_id" uuid,
	"reference_type" text,
	"reference_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"contract_id" uuid,
	"scheduled_date" date NOT NULL,
	"conducted_at" timestamp with time zone,
	"auditor_user_id" uuid,
	"status" "partner_audit_status" DEFAULT 'scheduled' NOT NULL,
	"score" numeric(5, 2),
	"items" jsonb,
	"findings" jsonb,
	"follow_up_due_date" date,
	"follow_up_done_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "partner_contracts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"prospect_id" uuid,
	"number" text NOT NULL,
	"option" "partner_option" DEFAULT 'option_b' NOT NULL,
	"initial_fee" bigint DEFAULT 0 NOT NULL,
	"subscription_fee_per_outlet" bigint NOT NULL,
	"royalty_bp" integer DEFAULT 0 NOT NULL,
	"water_discount_bp" integer DEFAULT 0 NOT NULL,
	"exclusive_radius_m" integer NOT NULL,
	"term_months" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"credit_limit" bigint DEFAULT 0 NOT NULL,
	"monthly_billing" boolean DEFAULT false NOT NULL,
	"status" "partner_contract_status" DEFAULT 'draft' NOT NULL,
	"agreement_attachment_id" uuid,
	"approval_request_id" uuid,
	"renewed_from_id" uuid,
	"pending_terms" jsonb,
	"pending_terms_effective_from" date,
	"terms_history" jsonb,
	"evaluation_interval_months" integer DEFAULT 3 NOT NULL,
	"next_evaluation_date" date,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"data_export_due_date" date,
	"data_exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "partner_contracts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "partner_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"conducted_at" timestamp with time zone,
	"conducted_by" uuid,
	"snapshot" jsonb,
	"summary" text,
	"recommendation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_monthly_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"data" jsonb NOT NULL,
	"sla_summary" jsonb,
	"pdf_attachment_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_portal_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"outlet_id" uuid,
	"kind" "portal_order_kind" NOT NULL,
	"status" "portal_order_status" DEFAULT 'submitted' NOT NULL,
	"requested_date" date,
	"requested_time" text,
	"tank_count" integer,
	"payment_method" text,
	"items" jsonb,
	"pickup" "spare_part_pickup",
	"estimated_amount" bigint DEFAULT 0 NOT NULL,
	"order_id" uuid,
	"pos_sale_id" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"rejected_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_prospects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_entity" text,
	"wa_phone" text NOT NULL,
	"proposed_address" text,
	"proposed_lat" double precision,
	"proposed_lng" double precision,
	"capital_amount" bigint,
	"status" "prospect_status" DEFAULT 'prospect' NOT NULL,
	"reference_water_source_id" uuid,
	"route_distance_m" integer,
	"tariff_zone_id" uuid,
	"radius_violation" boolean DEFAULT false NOT NULL,
	"radius_override_reason" text,
	"radius_override_by" uuid,
	"capacity_available" boolean,
	"infeasible_reason" text,
	"approval_request_id" uuid,
	"partner_tenant_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "partner_sanctions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"level" "sanction_level" NOT NULL,
	"status" "sanction_status" DEFAULT 'triggered' NOT NULL,
	"trigger" "sanction_trigger" NOT NULL,
	"trigger_detail" jsonb,
	"approval_request_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"letter_attachment_id" uuid,
	"effective_from" date,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "partner_scores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"period" text NOT NULL,
	"checklist_score" numeric(5, 2),
	"audit_score" numeric(5, 2),
	"test_score" numeric(5, 2),
	"weights" jsonb,
	"total_score" numeric(5, 2) NOT NULL,
	"below_threshold" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_support_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"kind" "support_request_kind" NOT NULL,
	"description" text NOT NULL,
	"photo_attachment_id" uuid,
	"status" "support_request_status" DEFAULT 'submitted' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" uuid,
	"sla_due_at" timestamp with time zone,
	"sla_breached" boolean DEFAULT false NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by" uuid,
	"response" text,
	"done_at" timestamp with time zone,
	"related_pos_sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_surveys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prospect_id" uuid NOT NULL,
	"surveyed_at" timestamp with time zone NOT NULL,
	"surveyor_user_id" uuid,
	"distance_notes" text,
	"density_notes" text,
	"competitor_notes" text,
	"layout_notes" text,
	"scores" jsonb,
	"recommendation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "quality_checklist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"checklist_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"label" text NOT NULL,
	"result" "check_result" NOT NULL,
	"photo_attachment_id" uuid,
	"action_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_checklists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"shift_id" uuid,
	"filled_by" uuid,
	"filled_at" timestamp with time zone NOT NULL,
	"passed_all" boolean NOT NULL,
	"device_id" uuid,
	"device_time" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_command_id" uuid,
	"recorded_by_office" boolean DEFAULT false NOT NULL,
	"office_record_reason" text,
	"late_sync" boolean DEFAULT false NOT NULL,
	"clock_skew_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "royalty_calculations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"period" text NOT NULL,
	"outlet_count" integer NOT NULL,
	"subscription_amount" bigint NOT NULL,
	"gross_sales" bigint DEFAULT 0 NOT NULL,
	"royalty_bp" integer DEFAULT 0 NOT NULL,
	"royalty_amount" bigint DEFAULT 0 NOT NULL,
	"detail" jsonb,
	"status" "royalty_status" DEFAULT 'provisional' NOT NULL,
	"invoice_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_logs" ADD CONSTRAINT "access_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymization_requests" ADD CONSTRAINT "anonymization_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymization_requests" ADD CONSTRAINT "anonymization_requests_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymization_requests" ADD CONSTRAINT "anonymization_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anonymization_requests" ADD CONSTRAINT "anonymization_requests_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_delegation_id_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."delegations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_device_id_devices_id_fk" FOREIGN KEY ("actor_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_status_logs" ADD CONSTRAINT "backup_status_logs_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_accountant_signed_by_users_id_fk" FOREIGN KEY ("accountant_signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_supersedes_id_data_signoffs_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."data_signoffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_signoffs" ADD CONSTRAINT "data_signoffs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_logs" ADD CONSTRAINT "device_usage_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_logs" ADD CONSTRAINT "device_usage_logs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_usage_logs" ADD CONSTRAINT "device_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_holder_employee_id_employees_id_fk" FOREIGN KEY ("holder_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_last_user_id_users_id_fk" FOREIGN KEY ("last_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_primary_outlet_id_outlets_id_fk" FOREIGN KEY ("primary_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_logs" ADD CONSTRAINT "export_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_default_operator_employee_id_employees_id_fk" FOREIGN KEY ("default_operator_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parameters" ADD CONSTRAINT "parameters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_enrollments" ADD CONSTRAINT "pin_enrollments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_enrollments" ADD CONSTRAINT "pin_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_enrollments" ADD CONSTRAINT "pin_enrollments_used_device_id_devices_id_fk" FOREIGN KEY ("used_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pin_enrollments" ADD CONSTRAINT "pin_enrollments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_commands" ADD CONSTRAINT "sync_commands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_message_logs" ADD CONSTRAINT "wa_message_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_message_logs" ADD CONSTRAINT "wa_message_logs_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_coordinate_locked_by_users_id_fk" FOREIGN KEY ("coordinate_locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_proposed_from_trip_id_trips_id_fk" FOREIGN KEY ("proposed_from_trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_tariff_zone_id_tariff_zones_id_fk" FOREIGN KEY ("tariff_zone_id") REFERENCES "public"."tariff_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_ref_source_fk" FOREIGN KEY ("reference_water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_zone_boundary_fk" FOREIGN KEY ("zone_boundary_id") REFERENCES "public"."tariff_zone_boundaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_history" ADD CONSTRAINT "customer_credit_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_history" ADD CONSTRAINT "customer_credit_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_history" ADD CONSTRAINT "customer_credit_history_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legacy_prices" ADD CONSTRAINT "customer_legacy_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legacy_prices" ADD CONSTRAINT "customer_legacy_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legacy_prices" ADD CONSTRAINT "customer_legacy_prices_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legacy_prices" ADD CONSTRAINT "customer_legacy_prices_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_legacy_prices" ADD CONSTRAINT "customer_legacy_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_monthly_billing_approval_id_approval_requests_id_fk" FOREIGN KEY ("monthly_billing_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_partner_outlet_id_outlets_id_fk" FOREIGN KEY ("partner_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_internal_outlet_id_outlets_id_fk" FOREIGN KEY ("internal_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_hold_deferral_set_by_users_id_fk" FOREIGN KEY ("hold_deferral_set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_hold_released_by_users_id_fk" FOREIGN KEY ("hold_released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_hold_release_approval_id_approval_requests_id_fk" FOREIGN KEY ("hold_release_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_monthly_agreement_fk" FOREIGN KEY ("monthly_billing_agreement_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depot_recipes" ADD CONSTRAINT "depot_recipes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depot_recipes" ADD CONSTRAINT "depot_recipes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depot_recipes" ADD CONSTRAINT "depot_recipes_material_product_id_products_id_fk" FOREIGN KEY ("material_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depot_recipes" ADD CONSTRAINT "depot_recipes_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depot_recipes" ADD CONSTRAINT "depot_recipes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_components" ADD CONSTRAINT "fuel_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_components" ADD CONSTRAINT "fuel_components_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_components" ADD CONSTRAINT "fuel_components_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_components" ADD CONSTRAINT "fuel_components_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch_rows" ADD CONSTRAINT "import_batch_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_file_attachment_id_attachments_id_fk" FOREIGN KEY ("file_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_locations" ADD CONSTRAINT "pool_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_locations" ADD CONSTRAINT "pool_locations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_locations" ADD CONSTRAINT "pool_locations_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_locations" ADD CONSTRAINT "pool_locations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_product_id_products_id_fk" FOREIGN KEY ("store_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_product_id_products_id_fk" FOREIGN KEY ("source_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_prices" ADD CONSTRAINT "special_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_prices" ADD CONSTRAINT "special_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_prices" ADD CONSTRAINT "special_prices_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_prices" ADD CONSTRAINT "special_prices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "special_prices" ADD CONSTRAINT "special_prices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zone_boundaries" ADD CONSTRAINT "tariff_zone_boundaries_tariff_zone_id_tariff_zones_id_fk" FOREIGN KEY ("tariff_zone_id") REFERENCES "public"."tariff_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zone_boundaries" ADD CONSTRAINT "tariff_zone_boundaries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zone_boundaries" ADD CONSTRAINT "tariff_zone_boundaries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zone_boundaries" ADD CONSTRAINT "tariff_zone_boundaries_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zones" ADD CONSTRAINT "tariff_zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zones" ADD CONSTRAINT "tariff_zones_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_zones" ADD CONSTRAINT "tariff_zones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_default_driver_employee_id_employees_id_fk" FOREIGN KEY ("default_driver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_default_helper_employee_id_employees_id_fk" FOREIGN KEY ("default_helper_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_gps_device_id_devices_id_fk" FOREIGN KEY ("gps_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_field_device_id_devices_id_fk" FOREIGN KEY ("field_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_pool_location_id_pool_locations_id_fk" FOREIGN KEY ("pool_location_id") REFERENCES "public"."pool_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_meters" ADD CONSTRAINT "water_meters_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_meters" ADD CONSTRAINT "water_meters_initial_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("initial_photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_meters" ADD CONSTRAINT "water_meters_replaced_by_meter_id_water_meters_id_fk" FOREIGN KEY ("replaced_by_meter_id") REFERENCES "public"."water_meters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_meters" ADD CONSTRAINT "water_meters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_sources" ADD CONSTRAINT "water_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_sources" ADD CONSTRAINT "water_sources_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_sources" ADD CONSTRAINT "water_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_tariffs" ADD CONSTRAINT "zone_tariffs_tariff_zone_id_tariff_zones_id_fk" FOREIGN KEY ("tariff_zone_id") REFERENCES "public"."tariff_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_tariffs" ADD CONSTRAINT "zone_tariffs_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_tariffs" ADD CONSTRAINT "zone_tariffs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zone_tariffs" ADD CONSTRAINT "zone_tariffs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_driver_employee_id_employees_id_fk" FOREIGN KEY ("driver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_assignments" ADD CONSTRAINT "crew_assignments_superseded_by_users_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_rosters" ADD CONSTRAINT "crew_rosters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_rosters" ADD CONSTRAINT "crew_rosters_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_rosters" ADD CONSTRAINT "crew_rosters_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_rosters" ADD CONSTRAINT "crew_rosters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_schedules" ADD CONSTRAINT "daily_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_schedules" ADD CONSTRAINT "daily_schedules_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_schedules" ADD CONSTRAINT "daily_schedules_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_schedules" ADD CONSTRAINT "daily_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_date_history" ADD CONSTRAINT "order_date_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_date_history" ADD CONSTRAINT "order_date_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tariff_zone_id_tariff_zones_id_fk" FOREIGN KEY ("tariff_zone_id") REFERENCES "public"."tariff_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_zone_tariff_id_zone_tariffs_id_fk" FOREIGN KEY ("zone_tariff_id") REFERENCES "public"."zone_tariffs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fuel_component_id_fuel_components_id_fk" FOREIGN KEY ("fuel_component_id") REFERENCES "public"."fuel_components"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_special_price_id_special_prices_id_fk" FOREIGN KEY ("special_price_id") REFERENCES "public"."special_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_updated_by_users_id_fk" FOREIGN KEY ("price_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_internal_outlet_id_outlets_id_fk" FOREIGN KEY ("internal_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_recurring_order_id_recurring_orders_id_fk" FOREIGN KEY ("recurring_order_id") REFERENCES "public"."recurring_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_duplicate_of_order_id_orders_id_fk" FOREIGN KEY ("duplicate_of_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reconfirmed_by_users_id_fk" FOREIGN KEY ("reconfirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_credit_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("credit_approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_underpayment_approval_fk" FOREIGN KEY ("underpayment_approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_customer_account_fk" FOREIGN KEY ("created_by_customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_customer_account_fk" FOREIGN KEY ("cancelled_by_customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_order_failures" ADD CONSTRAINT "recurring_order_failures_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_order_failures" ADD CONSTRAINT "recurring_order_failures_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_order_failures" ADD CONSTRAINT "recurring_order_failures_recurring_fk" FOREIGN KEY ("recurring_order_id") REFERENCES "public"."recurring_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD CONSTRAINT "recurring_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD CONSTRAINT "recurring_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD CONSTRAINT "recurring_orders_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_orders" ADD CONSTRAINT "recurring_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_logs" ADD CONSTRAINT "schedule_change_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_logs" ADD CONSTRAINT "schedule_change_logs_schedule_id_daily_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."daily_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_logs" ADD CONSTRAINT "schedule_change_logs_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_change_logs" ADD CONSTRAINT "schedule_change_logs_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_incidents" ADD CONSTRAINT "trip_incidents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_status_events" ADD CONSTRAINT "trip_status_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_destination_outlet_id_outlets_id_fk" FOREIGN KEY ("destination_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_schedule_id_daily_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."daily_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_employee_id_employees_id_fk" FOREIGN KEY ("driver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_helper_employee_id_employees_id_fk" FOREIGN KEY ("helper_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_reviewed_by_users_id_fk" FOREIGN KEY ("owner_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_signature_attachment_id_attachments_id_fk" FOREIGN KEY ("signature_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_sync_conflict_resolved_by_users_id_fk" FOREIGN KEY ("sync_conflict_resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_day_status" ADD CONSTRAINT "truck_day_status_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_day_status" ADD CONSTRAINT "truck_day_status_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_day_status" ADD CONSTRAINT "truck_day_status_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_receipt_attachment_id_attachments_id_fk" FOREIGN KEY ("receipt_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_office_cash_fk" FOREIGN KEY ("office_cash_movement_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."trip_expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_expenses" ADD CONSTRAINT "trip_expenses_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_transfer_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("transfer_proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_incoming_transfer_id_incoming_transfers_id_fk" FOREIGN KEY ("incoming_transfer_id") REFERENCES "public"."incoming_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_method_change_approval_id_approval_requests_id_fk" FOREIGN KEY ("method_change_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_reversal_of_id_trip_payments_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."trip_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_correction_approval_id_approval_requests_id_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_payments" ADD CONSTRAINT "trip_payments_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."trip_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_slip_attachment_id_attachments_id_fk" FOREIGN KEY ("slip_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_bank_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("bank_statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_reversal_of_id_bank_deposits_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."bank_deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_deposits" ADD CONSTRAINT "bank_deposits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_file_attachment_id_attachments_id_fk" FOREIGN KEY ("file_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_cash_day_id_cash_days_id_fk" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_close_exceptions" ADD CONSTRAINT "cash_close_exceptions_discrepancy_fk" FOREIGN KEY ("converted_discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_days" ADD CONSTRAINT "cash_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_days" ADD CONSTRAINT "cash_days_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_days" ADD CONSTRAINT "cash_days_office_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("office_discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_depositor_user_id_users_id_fk" FOREIGN KEY ("depositor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_depositor_employee_id_employees_id_fk" FOREIGN KEY ("depositor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_bank_slip_attachment_id_attachments_id_fk" FOREIGN KEY ("bank_slip_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_slip_transfer_id_incoming_transfers_id_fk" FOREIGN KEY ("slip_transfer_id") REFERENCES "public"."incoming_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_explained_by_users_id_fk" FOREIGN KEY ("explained_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_closed_below_threshold_by_users_id_fk" FOREIGN KEY ("closed_below_threshold_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_evidence_attachment_id_attachments_id_fk" FOREIGN KEY ("evidence_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_followed_up_by_users_id_fk" FOREIGN KEY ("followed_up_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_temporary_invoice_id_invoices_id_fk" FOREIGN KEY ("temporary_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_source_user_id_users_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_transfers" ADD CONSTRAINT "incoming_transfers_statement_line_fk" FOREIGN KEY ("bank_statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_cash_movements" ADD CONSTRAINT "office_cash_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_cash_movements" ADD CONSTRAINT "office_cash_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_cash_movements" ADD CONSTRAINT "office_cash_movements_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_counts" ADD CONSTRAINT "petty_cash_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_counts" ADD CONSTRAINT "petty_cash_counts_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_counts" ADD CONSTRAINT "petty_cash_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_receipt_attachment_id_attachments_id_fk" FOREIGN KEY ("receipt_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_approval_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_office_cash_fk" FOREIGN KEY ("office_cash_movement_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_transactions" ADD CONSTRAINT "petty_cash_transactions_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."petty_cash_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitution_settlements" ADD CONSTRAINT "restitution_settlements_restitution_id_restitutions_id_fk" FOREIGN KEY ("restitution_id") REFERENCES "public"."restitutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitution_settlements" ADD CONSTRAINT "restitution_settlements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitution_settlements" ADD CONSTRAINT "restitution_settlements_office_cash_fk" FOREIGN KEY ("office_cash_movement_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitution_settlements" ADD CONSTRAINT "restitution_settlements_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."restitution_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitutions" ADD CONSTRAINT "restitutions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitutions" ADD CONSTRAINT "restitutions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitutions" ADD CONSTRAINT "restitutions_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitutions" ADD CONSTRAINT "restitutions_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restitutions" ADD CONSTRAINT "restitutions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_source_payment_id_customer_payments_id_fk" FOREIGN KEY ("source_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_refund_approval_id_approval_requests_id_fk" FOREIGN KEY ("refund_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_refunded_by_users_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_advances" ADD CONSTRAINT "customer_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_incoming_transfer_id_incoming_transfers_id_fk" FOREIGN KEY ("incoming_transfer_id") REFERENCES "public"."incoming_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_driver_user_id_users_id_fk" FOREIGN KEY ("driver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversal_of_id_customer_payments_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."customer_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_office_cash_fk" FOREIGN KEY ("office_cash_movement_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_pos_sale_line_id_pos_sale_lines_id_fk" FOREIGN KEY ("pos_sale_line_id") REFERENCES "public"."pos_sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unbilled_charge_id_unbilled_charges_id_fk" FOREIGN KEY ("unbilled_charge_id") REFERENCES "public"."unbilled_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_address_id_customer_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_opening_confirmation_attachment_id_attachments_id_fk" FOREIGN KEY ("opening_confirmation_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_dispute_decided_by_users_id_fk" FOREIGN KEY ("dispute_decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_attachment_id_attachments_id_fk" FOREIGN KEY ("pdf_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pending_transfer_id_incoming_transfers_id_fk" FOREIGN KEY ("pending_transfer_id") REFERENCES "public"."incoming_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_write_off_journal_fk" FOREIGN KEY ("write_off_journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_write_off_approval_fk" FOREIGN KEY ("write_off_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_customer_payment_id_customer_payments_id_fk" FOREIGN KEY ("customer_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_customer_advance_id_customer_advances_id_fk" FOREIGN KEY ("customer_advance_id") REFERENCES "public"."customer_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_reversal_of_id_payment_allocations_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."payment_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_reminders" ADD CONSTRAINT "receivable_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_reminders" ADD CONSTRAINT "receivable_reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_reminders" ADD CONSTRAINT "receivable_reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_reminders" ADD CONSTRAINT "receivable_reminders_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unbilled_charges" ADD CONSTRAINT "unbilled_charges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unbilled_charges" ADD CONSTRAINT "unbilled_charges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unbilled_charges" ADD CONSTRAINT "unbilled_charges_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unbilled_charges" ADD CONSTRAINT "unbilled_charges_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unbilled_charges" ADD CONSTRAINT "unbilled_charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipt_lines" ADD CONSTRAINT "consumable_receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipt_lines" ADD CONSTRAINT "consumable_receipt_lines_receipt_id_consumable_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."consumable_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipt_lines" ADD CONSTRAINT "consumable_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_note_attachment_id_attachments_id_fk" FOREIGN KEY ("note_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_transfer_fk" FOREIGN KEY ("internal_transfer_id") REFERENCES "public"."internal_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."consumable_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumable_receipts" ADD CONSTRAINT "consumable_receipts_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_water_ledger" ADD CONSTRAINT "outlet_water_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_water_ledger" ADD CONSTRAINT "outlet_water_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_water_ledger" ADD CONSTRAINT "outlet_water_ledger_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."outlet_water_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_water_ledger" ADD CONSTRAINT "outlet_water_ledger_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sale_lines" ADD CONSTRAINT "pos_sale_lines_product_price_id_product_prices_id_fk" FOREIGN KEY ("product_price_id") REFERENCES "public"."product_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_discount_approval_id_approval_requests_id_fk" FOREIGN KEY ("discount_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_void_approval_id_approval_requests_id_fk" FOREIGN KEY ("void_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_replaces_sale_id_pos_sales_id_fk" FOREIGN KEY ("replaces_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_stock_counts" ADD CONSTRAINT "shift_stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_stock_counts" ADD CONSTRAINT "shift_stock_counts_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_stock_counts" ADD CONSTRAINT "shift_stock_counts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_stock_counts" ADD CONSTRAINT "shift_stock_counts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_operator_user_id_users_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_deposit_id_deposits_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."deposits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_conflict_resolved_by_users_id_fk" FOREIGN KEY ("conflict_resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_stock_count_id_stock_counts_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_co_counter_user_id_users_id_fk" FOREIGN KEY ("co_counter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_reversal_of_id_stock_ledger_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."stock_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."water_supply_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_supply_receipts" ADD CONSTRAINT "water_supply_receipts_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_lines" ADD CONSTRAINT "internal_transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_lines" ADD CONSTRAINT "internal_transfer_lines_transfer_id_internal_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."internal_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_lines" ADD CONSTRAINT "internal_transfer_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfer_lines" ADD CONSTRAINT "internal_transfer_lines_to_product_id_products_id_fk" FOREIGN KEY ("to_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_from_outlet_id_outlets_id_fk" FOREIGN KEY ("from_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_to_outlet_id_outlets_id_fk" FOREIGN KEY ("to_outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."internal_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_correction_approval_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_receipt_id_purchase_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_note_attachment_id_attachments_id_fk" FOREIGN KEY ("note_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_substitute_goods_photo_id_attachments_id_fk" FOREIGN KEY ("substitute_goods_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_substitute_accepted_by_users_id_fk" FOREIGN KEY ("substitute_accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_reversal_of_id_purchase_receipts_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_last_supplier_id_suppliers_id_fk" FOREIGN KEY ("last_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_ordered_supplier_id_suppliers_id_fk" FOREIGN KEY ("ordered_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_ordered_by_users_id_fk" FOREIGN KEY ("ordered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_items" ADD CONSTRAINT "reorder_items_closed_by_receipt_id_purchase_receipts_id_fk" FOREIGN KEY ("closed_by_receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_alloc_reversal_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."supplier_payment_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_alloc_correction_fk" FOREIGN KEY ("correction_approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_alloc_payment_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_alloc_receipt_fk" FOREIGN KEY ("purchase_receipt_id") REFERENCES "public"."purchase_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_proof_attachment_id_attachments_id_fk" FOREIGN KEY ("proof_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_reversal_of_id_supplier_payments_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."supplier_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_office_cash_fk" FOREIGN KEY ("office_cash_movement_id") REFERENCES "public"."office_cash_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_productions" ADD CONSTRAINT "daily_productions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_productions" ADD CONSTRAINT "daily_productions_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_productions" ADD CONSTRAINT "daily_productions_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_water_meter_id_water_meters_id_fk" FOREIGN KEY ("water_meter_id") REFERENCES "public"."water_meters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_previous_reading_id_meter_readings_id_fk" FOREIGN KEY ("previous_reading_id") REFERENCES "public"."meter_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_new_meter_id_water_meters_id_fk" FOREIGN KEY ("new_meter_id") REFERENCES "public"."water_meters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_applied_reading_id_meter_readings_id_fk" FOREIGN KEY ("applied_reading_id") REFERENCES "public"."meter_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_adjustments" ADD CONSTRAINT "meter_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_water_meter_id_water_meters_id_fk" FOREIGN KEY ("water_meter_id") REFERENCES "public"."water_meters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_superseded_by_id_meter_readings_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."meter_readings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_test_schedules" ADD CONSTRAINT "quality_test_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_test_schedules" ADD CONSTRAINT "quality_test_schedules_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_test_schedules" ADD CONSTRAINT "quality_test_schedules_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_test_schedules" ADD CONSTRAINT "quality_test_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_schedule_id_quality_test_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."quality_test_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_certificate_attachment_id_attachments_id_fk" FOREIGN KEY ("certificate_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_action_owner_employee_id_employees_id_fk" FOREIGN KEY ("action_owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_tests" ADD CONSTRAINT "quality_tests_action_done_by_users_id_fk" FOREIGN KEY ("action_done_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_level_readings" ADD CONSTRAINT "tank_level_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_level_readings" ADD CONSTRAINT "tank_level_readings_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_level_readings" ADD CONSTRAINT "tank_level_readings_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_level_readings" ADD CONSTRAINT "tank_level_readings_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_level_readings" ADD CONSTRAINT "tank_level_readings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_reversal_of_id_truck_fills_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."truck_fills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_requested_trip_id_trips_id_fk" FOREIGN KEY ("requested_trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_fills" ADD CONSTRAINT "truck_fills_reversed_by_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."truck_fills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_investigation_photo_id_attachments_id_fk" FOREIGN KEY ("investigation_photo_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_investigated_by_users_id_fk" FOREIGN KEY ("investigated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "water_balances" ADD CONSTRAINT "water_balances_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_cash_day_id_cash_days_id_fk" FOREIGN KEY ("cash_day_id") REFERENCES "public"."cash_days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summaries" ADD CONSTRAINT "daily_summaries_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_summary_addenda" ADD CONSTRAINT "daily_summary_addenda_daily_summary_id_daily_summaries_id_fk" FOREIGN KEY ("daily_summary_id") REFERENCES "public"."daily_summaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_manual_inputs" ADD CONSTRAINT "kpi_manual_inputs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_manual_inputs" ADD CONSTRAINT "kpi_manual_inputs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parallel_run_checks" ADD CONSTRAINT "parallel_run_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parallel_run_checks" ADD CONSTRAINT "parallel_run_checks_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parallel_run_checks" ADD CONSTRAINT "parallel_run_checks_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parallel_run_checks" ADD CONSTRAINT "parallel_run_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_superseded_by_id_report_snapshots_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."report_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_paper_withdrawals" ADD CONSTRAINT "unit_paper_withdrawals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_paper_withdrawals" ADD CONSTRAINT "unit_paper_withdrawals_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_paper_withdrawals" ADD CONSTRAINT "unit_paper_withdrawals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_paper_withdrawals" ADD CONSTRAINT "unit_paper_withdrawals_early_withdrawal_approved_by_users_id_fk" FOREIGN KEY ("early_withdrawal_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_paper_withdrawals" ADD CONSTRAINT "unit_paper_withdrawals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_manual_review_marked_by_users_id_fk" FOREIGN KEY ("manual_review_marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_discrepancy_id_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."discrepancies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_allocation_runs" ADD CONSTRAINT "cost_allocation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_fixed_asset_id_fixed_assets_id_fk" FOREIGN KEY ("fixed_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_account_mappings" ADD CONSTRAINT "event_account_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_account_mappings" ADD CONSTRAINT "event_account_mappings_debit_account_id_accounts_id_fk" FOREIGN KEY ("debit_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_account_mappings" ADD CONSTRAINT "event_account_mappings_credit_account_id_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_account_mappings" ADD CONSTRAINT "event_account_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_templates" ADD CONSTRAINT "export_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_templates" ADD CONSTRAINT "export_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_extras" ADD CONSTRAINT "fixed_asset_extras_fixed_asset_id_fixed_assets_id_fk" FOREIGN KEY ("fixed_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_extras" ADD CONSTRAINT "fixed_asset_extras_acquisition_journal_id_journals_id_fk" FOREIGN KEY ("acquisition_journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_account_id_accounts_id_fk" FOREIGN KEY ("accumulated_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_id_journals_id_fk" FOREIGN KEY ("disposal_journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_water_source_id_water_sources_id_fk" FOREIGN KEY ("water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payable_settlements" ADD CONSTRAINT "journal_payable_settlements_payable_id_journal_payables_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."journal_payables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payable_settlements" ADD CONSTRAINT "journal_payable_settlements_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payables" ADD CONSTRAINT "journal_payables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payables" ADD CONSTRAINT "journal_payables_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payables" ADD CONSTRAINT "journal_payables_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_payables" ADD CONSTRAINT "journal_payables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_queue" ADD CONSTRAINT "journal_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_queue" ADD CONSTRAINT "journal_queue_domain_event_id_domain_events_id_fk" FOREIGN KEY ("domain_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_queue" ADD CONSTRAINT "journal_queue_resolved_journal_id_journals_id_fk" FOREIGN KEY ("resolved_journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_source_event_id_domain_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_owner_reviewed_by_users_id_fk" FOREIGN KEY ("owner_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_reversal_of_id_journals_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journal_details" ADD CONSTRAINT "manual_journal_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journal_details" ADD CONSTRAINT "manual_journal_details_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_journal_details" ADD CONSTRAINT "manual_journal_details_recurring_fk" FOREIGN KEY ("recurring_journal_id") REFERENCES "public"."recurring_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_accountant_approved_by_users_id_fk" FOREIGN KEY ("accountant_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_batches" ADD CONSTRAINT "opening_balance_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_batch_id_opening_balance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."opening_balance_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_balance_lines" ADD CONSTRAINT "opening_balance_lines_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_review_notes" ADD CONSTRAINT "period_review_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_review_notes" ADD CONSTRAINT "period_review_notes_period_id_accounting_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."accounting_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_review_notes" ADD CONSTRAINT "period_review_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_centers" ADD CONSTRAINT "profit_centers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retroactive_runs" ADD CONSTRAINT "retroactive_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retroactive_runs" ADD CONSTRAINT "retroactive_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retroactive_runs" ADD CONSTRAINT "retroactive_runs_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_scheme_rates" ADD CONSTRAINT "tax_scheme_rates_tax_setting_id_tax_settings_id_fk" FOREIGN KEY ("tax_setting_id") REFERENCES "public"."tax_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_explained_by_users_id_fk" FOREIGN KEY ("explained_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_explanation_device_id_devices_id_fk" FOREIGN KEY ("explanation_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_events" ADD CONSTRAINT "fleet_events_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_estimates" ADD CONSTRAINT "fuel_estimates_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_estimates" ADD CONSTRAINT "fuel_estimates_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gps_positions" ADD CONSTRAINT "gps_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tracking_flags" ADD CONSTRAINT "phone_tracking_flags_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tracking_flags" ADD CONSTRAINT "phone_tracking_flags_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_tracking_flags" ADD CONSTRAINT "phone_tracking_flags_fleet_event_id_fleet_events_id_fk" FOREIGN KEY ("fleet_event_id") REFERENCES "public"."fleet_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_tracks" ADD CONSTRAINT "trip_tracks_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_tracks" ADD CONSTRAINT "trip_tracks_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truck_day_summaries" ADD CONSTRAINT "truck_day_summaries_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_actions" ADD CONSTRAINT "complaint_actions_complaint_id_complaints_id_fk" FOREIGN KEY ("complaint_id") REFERENCES "public"."complaints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaint_actions" ADD CONSTRAINT "complaint_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_first_response_by_users_id_fk" FOREIGN KEY ("first_response_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_requests" ADD CONSTRAINT "customer_account_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_requests" ADD CONSTRAINT "customer_account_requests_candidate_customer_id_customers_id_fk" FOREIGN KEY ("candidate_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_requests" ADD CONSTRAINT "customer_account_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_account_requests" ADD CONSTRAINT "customer_account_requests_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_accounts" ADD CONSTRAINT "customer_accounts_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_app_orders" ADD CONSTRAINT "customer_app_orders_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_download_logs" ADD CONSTRAINT "customer_download_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_download_logs" ADD CONSTRAINT "customer_download_logs_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_push_subscriptions" ADD CONSTRAINT "customer_push_subscriptions_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_customer_payment_id_customer_payments_id_fk" FOREIGN KEY ("customer_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_incoming_transfer_id_incoming_transfers_id_fk" FOREIGN KEY ("incoming_transfer_id") REFERENCES "public"."incoming_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_change_requests" ADD CONSTRAINT "phone_change_requests_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_reminder_prefs" ADD CONSTRAINT "refill_reminder_prefs_account_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_customer_account_id_customer_accounts_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_truck_id_trucks_id_fk" FOREIGN KEY ("truck_id") REFERENCES "public"."trucks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_driver_employee_id_employees_id_fk" FOREIGN KEY ("driver_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_message_costs" ADD CONSTRAINT "wa_message_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusive_territories" ADD CONSTRAINT "exclusive_territories_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exclusive_territories" ADD CONSTRAINT "exclusive_territories_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_checklists" ADD CONSTRAINT "onboarding_checklists_evidence_attachment_id_attachments_id_fk" FOREIGN KEY ("evidence_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_audits" ADD CONSTRAINT "partner_audits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_audits" ADD CONSTRAINT "partner_audits_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_audits" ADD CONSTRAINT "partner_audits_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_audits" ADD CONSTRAINT "partner_audits_auditor_user_id_users_id_fk" FOREIGN KEY ("auditor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_audits" ADD CONSTRAINT "partner_audits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_prospect_id_partner_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."partner_prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_agreement_attachment_id_attachments_id_fk" FOREIGN KEY ("agreement_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_renewed_from_id_partner_contracts_id_fk" FOREIGN KEY ("renewed_from_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_contracts" ADD CONSTRAINT "partner_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_evaluations" ADD CONSTRAINT "partner_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_evaluations" ADD CONSTRAINT "partner_evaluations_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_evaluations" ADD CONSTRAINT "partner_evaluations_conducted_by_users_id_fk" FOREIGN KEY ("conducted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_monthly_reports" ADD CONSTRAINT "partner_monthly_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_monthly_reports" ADD CONSTRAINT "partner_monthly_reports_pdf_attachment_id_attachments_id_fk" FOREIGN KEY ("pdf_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_portal_orders" ADD CONSTRAINT "partner_portal_orders_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_reference_water_source_id_water_sources_id_fk" FOREIGN KEY ("reference_water_source_id") REFERENCES "public"."water_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_tariff_zone_id_tariff_zones_id_fk" FOREIGN KEY ("tariff_zone_id") REFERENCES "public"."tariff_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_radius_override_by_users_id_fk" FOREIGN KEY ("radius_override_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_partner_tenant_id_tenants_id_fk" FOREIGN KEY ("partner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_prospects" ADD CONSTRAINT "partner_prospects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_letter_attachment_id_attachments_id_fk" FOREIGN KEY ("letter_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_sanctions" ADD CONSTRAINT "partner_sanctions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_scores" ADD CONSTRAINT "partner_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_scores" ADD CONSTRAINT "partner_scores_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_support_requests" ADD CONSTRAINT "partner_support_requests_related_pos_sale_id_pos_sales_id_fk" FOREIGN KEY ("related_pos_sale_id") REFERENCES "public"."pos_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_surveys" ADD CONSTRAINT "partner_surveys_prospect_id_partner_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."partner_prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_surveys" ADD CONSTRAINT "partner_surveys_surveyor_user_id_users_id_fk" FOREIGN KEY ("surveyor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_surveys" ADD CONSTRAINT "partner_surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklist_items" ADD CONSTRAINT "quality_checklist_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklist_items" ADD CONSTRAINT "quality_checklist_items_checklist_id_quality_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."quality_checklists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklist_items" ADD CONSTRAINT "quality_checklist_items_photo_attachment_id_attachments_id_fk" FOREIGN KEY ("photo_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklists" ADD CONSTRAINT "quality_checklists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklists" ADD CONSTRAINT "quality_checklists_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklists" ADD CONSTRAINT "quality_checklists_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklists" ADD CONSTRAINT "quality_checklists_filled_by_users_id_fk" FOREIGN KEY ("filled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checklists" ADD CONSTRAINT "quality_checklists_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_calculations" ADD CONSTRAINT "royalty_calculations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_calculations" ADD CONSTRAINT "royalty_calculations_contract_id_partner_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."partner_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "royalty_calculations" ADD CONSTRAINT "royalty_calculations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_logs_user_idx" ON "access_logs" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "access_logs_event_idx" ON "access_logs" USING btree ("event","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_reviews_tenant_quarter_uq" ON "access_reviews" USING btree ("tenant_id","quarter");--> statement-breakpoint
CREATE INDEX "anonymization_requests_subject_idx" ON "anonymization_requests" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "approval_requests_status_idx" ON "approval_requests" USING btree ("status","approver_role","deadline_at");--> statement-breakpoint
CREATE INDEX "approval_requests_object_idx" ON "approval_requests" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "approval_requests_requester_idx" ON "approval_requests" USING btree ("requester_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_tenant_number_uq" ON "approval_requests" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_live_uq" ON "approval_requests" USING btree ("tenant_id","type","object_type","object_id") WHERE "approval_requests"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "attachments_object_idx" ON "attachments" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_logs_object_idx" ON "audit_logs" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","server_time");--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("server_time");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_prev_hash_uq" ON "audit_logs" USING btree ("prev_hash") WHERE "audit_logs"."prev_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_genesis_uq" ON "audit_logs" USING btree ((true)) WHERE "audit_logs"."prev_hash" is null;--> statement-breakpoint
CREATE INDEX "backup_status_logs_kind_idx" ON "backup_status_logs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "data_signoffs_group_idx" ON "data_signoffs" USING btree ("tenant_id","group");--> statement-breakpoint
CREATE INDEX "delegations_delegate_idx" ON "delegations" USING btree ("delegate_user_id","valid_until");--> statement-breakpoint
CREATE INDEX "device_usage_logs_device_idx" ON "device_usage_logs" USING btree ("device_id","occurred_at");--> statement-breakpoint
CREATE INDEX "device_usage_logs_tenant_idx" ON "device_usage_logs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "devices_tenant_kind_idx" ON "devices" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "devices_status_idx" ON "devices" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "document_sequences_tenant_kind_scope_uq" ON "document_sequences" USING btree ("tenant_id","kind","scope_key");--> statement-breakpoint
CREATE INDEX "domain_events_type_idx" ON "domain_events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "domain_events_object_idx" ON "domain_events" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_tenant_no_uq" ON "employees" USING btree ("tenant_id","employee_no");--> statement-breakpoint
CREATE INDEX "employees_tenant_idx" ON "employees" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "export_logs_user_idx" ON "export_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_global_uq" ON "feature_flags" USING btree ("key","scope_type") WHERE "feature_flags"."scope_ref_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_scoped_uq" ON "feature_flags" USING btree ("key","scope_type","scope_ref_id") WHERE "feature_flags"."scope_ref_id" is not null;--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("status","detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_job_run_uq" ON "job_runs" USING btree ("job_key","run_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_event_uq" ON "notification_preferences" USING btree ("user_id","event");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_object_idx" ON "notifications" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outlets_tenant_code_uq" ON "outlets" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "outlets_tenant_idx" ON "outlets" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parameters_global_uq" ON "parameters" USING btree ("key","effective_from") WHERE "parameters"."tenant_id" is null and "parameters"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "parameters_tenant_uq" ON "parameters" USING btree ("key","tenant_id","effective_from") WHERE "parameters"."tenant_id" is not null and "parameters"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "parameters_outlet_uq" ON "parameters" USING btree ("key","outlet_id","effective_from") WHERE "parameters"."outlet_id" is not null;--> statement-breakpoint
CREATE INDEX "parameters_key_idx" ON "parameters" USING btree ("key","effective_from");--> statement-breakpoint
CREATE INDEX "pin_enrollments_code_idx" ON "pin_enrollments" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "pin_enrollments_user_idx" ON "pin_enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_outages_service_start_uq" ON "service_outages" USING btree ("service","started_at");--> statement-breakpoint
CREATE INDEX "service_outages_started_idx" ON "service_outages" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sync_commands_device_idx" ON "sync_commands" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "sync_commands_status_idx" ON "sync_commands" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_live_uq" ON "user_roles" USING btree ("user_id","role") WHERE "user_roles"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_scopes_live_uq" ON "user_scopes" USING btree ("user_id","scope_type","ref_id") WHERE "user_scopes"."status" in ('pending', 'active');--> statement-breakpoint
CREATE INDEX "user_scopes_ref_idx" ON "user_scopes" USING btree ("scope_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uq" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wa_message_logs_object_idx" ON "wa_message_logs" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "wa_message_logs_customer_idx" ON "wa_message_logs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_addresses_zone_idx" ON "customer_addresses" USING btree ("tariff_zone_id");--> statement-breakpoint
CREATE INDEX "customer_credit_history_cust_idx" ON "customer_credit_history" USING btree ("customer_id","changed_at");--> statement-breakpoint
CREATE INDEX "customer_legacy_prices_customer_idx" ON "customer_legacy_prices" USING btree ("customer_id","is_current");--> statement-breakpoint
CREATE INDEX "customer_legacy_prices_tenant_idx" ON "customer_legacy_prices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customers_tenant_segment_idx" ON "customers" USING btree ("tenant_id","segment");--> statement-breakpoint
CREATE INDEX "customers_wa_idx" ON "customers" USING btree ("wa_phone");--> statement-breakpoint
CREATE INDEX "customers_name_lower_idx" ON "customers" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "customers_credit_status_idx" ON "customers" USING btree ("credit_status");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_code_uq" ON "customers" USING btree ("tenant_id","code") WHERE "customers"."code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_internal_outlet_uq" ON "customers" USING btree ("internal_outlet_id") WHERE "customers"."internal_outlet_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "depot_recipes_product_material_from_uq" ON "depot_recipes" USING btree ("product_id","material_product_id","effective_from");--> statement-breakpoint
CREATE INDEX "fuel_components_tenant_from_idx" ON "fuel_components" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "fuel_components_active_uq" ON "fuel_components" USING btree ("tenant_id","effective_from") WHERE "fuel_components"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "import_batch_rows_batch_row_uq" ON "import_batch_rows" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE INDEX "import_batches_tenant_kind_idx" ON "import_batches" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_locations_tenant_code_uq" ON "pool_locations" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "product_prices_product_idx" ON "product_prices" USING btree ("product_id","kind","effective_from");--> statement-breakpoint
CREATE INDEX "product_prices_tenant_idx" ON "product_prices" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_active_uq" ON "product_prices" USING btree ("product_id","kind","effective_from") WHERE "product_prices"."status" = 'active' and "product_prices"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_active_outlet_uq" ON "product_prices" USING btree ("product_id","kind","outlet_id","effective_from") WHERE "product_prices"."status" = 'active' and "product_prices"."outlet_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_code_uq" ON "products" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "products_tenant_line_idx" ON "products" USING btree ("tenant_id","line");--> statement-breakpoint
CREATE INDEX "special_prices_customer_idx" ON "special_prices" USING btree ("customer_id","product_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "special_prices_active_uq" ON "special_prices" USING btree ("customer_id","product_id","valid_from") WHERE "special_prices"."status" = 'active';--> statement-breakpoint
CREATE INDEX "tariff_zone_boundaries_zone_from_idx" ON "tariff_zone_boundaries" USING btree ("tariff_zone_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_zone_boundaries_active_uq" ON "tariff_zone_boundaries" USING btree ("tariff_zone_id","effective_from") WHERE "tariff_zone_boundaries"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "tariff_zones_tenant_code_uq" ON "tariff_zones" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "trucks_tenant_code_uq" ON "trucks" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_templates_tenant_kind_version_uq" ON "wa_templates" USING btree ("tenant_id","kind","version");--> statement-breakpoint
CREATE INDEX "water_meters_source_idx" ON "water_meters" USING btree ("water_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "water_sources_tenant_code_uq" ON "water_sources" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "zone_tariffs_zone_from_idx" ON "zone_tariffs" USING btree ("tariff_zone_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "zone_tariffs_active_segment_uq" ON "zone_tariffs" USING btree ("tariff_zone_id","segment","effective_from") WHERE "zone_tariffs"."status" = 'active' and "zone_tariffs"."segment" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "zone_tariffs_active_all_uq" ON "zone_tariffs" USING btree ("tariff_zone_id","effective_from") WHERE "zone_tariffs"."status" = 'active' and "zone_tariffs"."segment" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_assignments_truck_live_uq" ON "crew_assignments" USING btree ("truck_id","business_date") WHERE "crew_assignments"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_assignments_driver_live_uq" ON "crew_assignments" USING btree ("driver_employee_id","business_date") WHERE "crew_assignments"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_rosters_employee_date_uq" ON "crew_rosters" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE INDEX "crew_rosters_date_idx" ON "crew_rosters" USING btree ("business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_schedules_truck_date_uq" ON "daily_schedules" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "daily_schedules_date_idx" ON "daily_schedules" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "order_date_history_order_idx" ON "order_date_history" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_customer_date_idx" ON "orders" USING btree ("customer_id","requested_date");--> statement-breakpoint
CREATE INDEX "orders_status_date_idx" ON "orders" USING btree ("status","requested_date");--> statement-breakpoint
CREATE INDEX "orders_address_date_idx" ON "orders" USING btree ("address_id","requested_date");--> statement-breakpoint
CREATE INDEX "orders_tenant_date_idx" ON "orders" USING btree ("tenant_id","requested_date");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_recurring_date_uq" ON "orders" USING btree ("recurring_order_id","requested_date") WHERE "orders"."recurring_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_order_failures_uq" ON "recurring_order_failures" USING btree ("recurring_order_id","target_date");--> statement-breakpoint
CREATE INDEX "recurring_orders_status_idx" ON "recurring_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recurring_orders_customer_idx" ON "recurring_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "schedule_change_logs_trip_idx" ON "schedule_change_logs" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "schedule_change_logs_schedule_idx" ON "schedule_change_logs" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "trip_incidents_trip_idx" ON "trip_incidents" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_incidents_date_idx" ON "trip_incidents" USING btree ("business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_incidents_sync_command_uq" ON "trip_incidents" USING btree ("sync_command_id") WHERE "trip_incidents"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "trip_status_events_trip_idx" ON "trip_status_events" USING btree ("trip_id","created_at");--> statement-breakpoint
CREATE INDEX "trips_truck_date_idx" ON "trips" USING btree ("truck_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "trips_truck_completion_idx" ON "trips" USING btree ("truck_id","completion_business_date");--> statement-breakpoint
CREATE INDEX "trips_order_idx" ON "trips" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "trips_status_date_idx" ON "trips" USING btree ("status","scheduled_date");--> statement-breakpoint
CREATE INDEX "trips_customer_idx" ON "trips" USING btree ("customer_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "trips_driver_date_idx" ON "trips" USING btree ("driver_user_id","scheduled_date");--> statement-breakpoint
CREATE UNIQUE INDEX "trips_order_seq_uq" ON "trips" USING btree ("order_id","sequence_in_order");--> statement-breakpoint
CREATE UNIQUE INDEX "truck_day_status_truck_date_uq" ON "truck_day_status" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "trip_expenses_truck_date_idx" ON "trip_expenses" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "trip_expenses_deposit_idx" ON "trip_expenses" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "trip_expenses_status_idx" ON "trip_expenses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_expenses_reversal_uq" ON "trip_expenses" USING btree ("reversal_of_id") WHERE "trip_expenses"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_expenses_sync_command_uq" ON "trip_expenses" USING btree ("sync_command_id") WHERE "trip_expenses"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "trip_payments_trip_idx" ON "trip_payments" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_payments_driver_date_idx" ON "trip_payments" USING btree ("driver_user_id","business_date");--> statement-breakpoint
CREATE INDEX "trip_payments_deposit_idx" ON "trip_payments" USING btree ("deposit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_payments_live_uq" ON "trip_payments" USING btree ("trip_id") WHERE "trip_payments"."reversal_of_id" is null and "trip_payments"."reversed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_payments_reversal_uq" ON "trip_payments" USING btree ("reversal_of_id") WHERE "trip_payments"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_payments_sync_command_uq" ON "trip_payments" USING btree ("sync_command_id") WHERE "trip_payments"."sync_command_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_tenant_number_uq" ON "bank_accounts" USING btree ("tenant_id","account_number");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_gl_account_uq" ON "bank_accounts" USING btree ("gl_account_id");--> statement-breakpoint
CREATE INDEX "bank_deposits_date_idx" ON "bank_deposits" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "bank_statement_imports_account_idx" ON "bank_statement_imports" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_account_hash_uq" ON "bank_statement_lines" USING btree ("bank_account_id","row_hash");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_status_idx" ON "bank_statement_lines" USING btree ("status","line_date");--> statement-breakpoint
CREATE INDEX "cash_close_exceptions_day_idx" ON "cash_close_exceptions" USING btree ("cash_day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_days_tenant_date_uq" ON "cash_days" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_tenant_number_uq" ON "deposits" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_driver_day_uq" ON "deposits" USING btree ("depositor_user_id","business_date") WHERE "deposits"."source_type" = 'driver';--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_shift_final_uq" ON "deposits" USING btree ("shift_id") WHERE "deposits"."shift_id" is not null and "deposits"."is_partial" = false;--> statement-breakpoint
CREATE INDEX "deposits_status_date_idx" ON "deposits" USING btree ("status","business_date");--> statement-breakpoint
CREATE INDEX "deposits_date_idx" ON "deposits" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "discrepancies_status_idx" ON "discrepancies" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "discrepancies_employee_idx" ON "discrepancies" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE INDEX "discrepancies_deposit_idx" ON "discrepancies" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "incoming_transfers_status_idx" ON "incoming_transfers" USING btree ("status","transfer_date");--> statement-breakpoint
CREATE INDEX "incoming_transfers_customer_idx" ON "incoming_transfers" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_transfers_source_uq" ON "incoming_transfers" USING btree ("source_object_type","source_object_id") WHERE "incoming_transfers"."source_object_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "incoming_transfers_qris_shift_uq" ON "incoming_transfers" USING btree ("shift_id") WHERE "incoming_transfers"."source_kind" = 'qris_shift' and "incoming_transfers"."shift_id" is not null;--> statement-breakpoint
CREATE INDEX "office_cash_movements_date_idx" ON "office_cash_movements" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "office_cash_movements_source_idx" ON "office_cash_movements" USING btree ("source_object_type","source_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "office_cash_movements_source_uq" ON "office_cash_movements" USING btree ("kind","source_object_type","source_object_id") WHERE "office_cash_movements"."reversal_of_id" is null and "office_cash_movements"."source_object_id" is not null;--> statement-breakpoint
CREATE INDEX "petty_cash_counts_date_idx" ON "petty_cash_counts" USING btree ("tenant_id","count_date");--> statement-breakpoint
CREATE INDEX "petty_cash_transactions_date_idx" ON "petty_cash_transactions" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "restitution_settlements_restitution_idx" ON "restitution_settlements" USING btree ("restitution_id");--> statement-breakpoint
CREATE INDEX "restitutions_employee_idx" ON "restitutions" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "customer_advances_customer_idx" ON "customer_advances" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_advances_order_idx" ON "customer_advances" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "customer_payments" USING btree ("customer_id","business_date");--> statement-breakpoint
CREATE INDEX "customer_payments_deposit_idx" ON "customer_payments" USING btree ("deposit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_sync_command_uq" ON "customer_payments" USING btree ("sync_command_id") WHERE "customer_payments"."sync_command_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_invoice_line_uq" ON "invoice_lines" USING btree ("invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "invoices_customer_status_idx" ON "invoices" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "invoices_due_status_idx" ON "invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_pos_sale_uq" ON "invoices" USING btree ("pos_sale_id") WHERE "invoices"."pos_sale_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_kind_trip_uq" ON "invoices" USING btree ("kind","trip_id") WHERE "invoices"."trip_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_monthly_uq" ON "invoices" USING btree ("customer_id","kind","period_month") WHERE "invoices"."kind" in ('monthly', 'partner_subscription');--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("customer_payment_id");--> statement-breakpoint
CREATE INDEX "receivable_reminders_date_idx" ON "receivable_reminders" USING btree ("scheduled_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "receivable_reminders_invoice_kind_uq" ON "receivable_reminders" USING btree ("invoice_id","kind") WHERE "receivable_reminders"."invoice_id" is not null;--> statement-breakpoint
CREATE INDEX "unbilled_charges_customer_idx" ON "unbilled_charges" USING btree ("customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "unbilled_charges_trip_uq" ON "unbilled_charges" USING btree ("trip_id") WHERE "unbilled_charges"."trip_id" is not null;--> statement-breakpoint
CREATE INDEX "consumable_receipt_lines_receipt_idx" ON "consumable_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "consumable_receipt_lines_tenant_idx" ON "consumable_receipt_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "consumable_receipts_outlet_idx" ON "consumable_receipts" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "consumable_receipts_transfer_uq" ON "consumable_receipts" USING btree ("internal_transfer_id") WHERE "consumable_receipts"."internal_transfer_id" is not null and "consumable_receipts"."reversal_of_id" is null and "consumable_receipts"."reversed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "consumable_receipts_reversal_uq" ON "consumable_receipts" USING btree ("reversal_of_id") WHERE "consumable_receipts"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "consumable_receipts_sync_command_uq" ON "consumable_receipts" USING btree ("sync_command_id") WHERE "consumable_receipts"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "outlet_water_ledger_outlet_idx" ON "outlet_water_ledger" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "outlet_water_ledger_source_idx" ON "outlet_water_ledger" USING btree ("source_object_type","source_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outlet_water_ledger_reversal_uq" ON "outlet_water_ledger" USING btree ("reversal_of_id") WHERE "outlet_water_ledger"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "outlet_water_ledger_source_uq" ON "outlet_water_ledger" USING btree ("source_object_type","source_object_id","kind") WHERE "outlet_water_ledger"."reversal_of_id" is null and "outlet_water_ledger"."source_object_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sale_lines_sale_line_uq" ON "pos_sale_lines" USING btree ("pos_sale_id","line_no");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_product_idx" ON "pos_sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_outlet_date_idx" ON "pos_sale_lines" USING btree ("outlet_id","business_date","product_id");--> statement-breakpoint
CREATE INDEX "pos_sale_lines_tenant_date_idx" ON "pos_sale_lines" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_outlet_number_uq" ON "pos_sales" USING btree ("outlet_id","number") WHERE "pos_sales"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_device_local_number_uq" ON "pos_sales" USING btree ("device_id","local_number");--> statement-breakpoint
CREATE INDEX "pos_sales_outlet_date_idx" ON "pos_sales" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "pos_sales_tenant_date_idx" ON "pos_sales" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "pos_sales_shift_idx" ON "pos_sales" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "pos_sales_customer_idx" ON "pos_sales" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_reversal_uq" ON "pos_sales" USING btree ("reversal_of_id") WHERE "pos_sales"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_stock_counts_uq" ON "shift_stock_counts" USING btree ("shift_id","product_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_outlet_uq" ON "shifts" USING btree ("outlet_id") WHERE "shifts"."status" = 'open' and "shifts"."sync_conflict" = false;--> statement-breakpoint
CREATE INDEX "shifts_outlet_date_idx" ON "shifts" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "shifts_deposit_status_idx" ON "shifts" USING btree ("deposit_status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_outlet_product_uq" ON "stock_balances" USING btree ("outlet_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_lines_uq" ON "stock_count_lines" USING btree ("stock_count_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_count_lines_tenant_idx" ON "stock_count_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_counts_outlet_idx" ON "stock_counts" USING btree ("outlet_id","period_label");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_sync_command_uq" ON "stock_counts" USING btree ("sync_command_id") WHERE "stock_counts"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_ledger_outlet_product_idx" ON "stock_ledger" USING btree ("outlet_id","product_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_source_idx" ON "stock_ledger" USING btree ("source_object_type","source_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_ledger_source_uq" ON "stock_ledger" USING btree ("source_object_type","source_object_id","product_id","kind") WHERE "stock_ledger"."reversal_of_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "water_supply_receipts_trip_uq" ON "water_supply_receipts" USING btree ("trip_id") WHERE "water_supply_receipts"."trip_id" is not null and "water_supply_receipts"."reversal_of_id" is null and "water_supply_receipts"."reversed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "water_supply_receipts_reversal_uq" ON "water_supply_receipts" USING btree ("reversal_of_id") WHERE "water_supply_receipts"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "water_supply_receipts_sync_command_uq" ON "water_supply_receipts" USING btree ("sync_command_id") WHERE "water_supply_receipts"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "water_supply_receipts_outlet_idx" ON "water_supply_receipts" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "water_supply_receipts_status_idx" ON "water_supply_receipts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "internal_transfer_lines_transfer_idx" ON "internal_transfer_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "internal_transfer_lines_tenant_idx" ON "internal_transfer_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "internal_transfers_to_outlet_idx" ON "internal_transfers" USING btree ("to_outlet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "internal_transfers_tenant_number_uq" ON "internal_transfers" USING btree ("tenant_id","number") WHERE "internal_transfers"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_transfers_device_local_number_uq" ON "internal_transfers" USING btree ("device_id","local_number") WHERE "internal_transfers"."local_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "internal_transfers_reversal_uq" ON "internal_transfers" USING btree ("reversal_of_id") WHERE "internal_transfers"."reversal_of_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_receipt_idx" ON "purchase_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "purchase_receipt_lines_tenant_idx" ON "purchase_receipt_lines" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "purchase_receipts_supplier_idx" ON "purchase_receipts" USING btree ("supplier_id","payment_status");--> statement-breakpoint
CREATE INDEX "purchase_receipts_outlet_date_idx" ON "purchase_receipts" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_tenant_number_uq" ON "purchase_receipts" USING btree ("tenant_id","number") WHERE "purchase_receipts"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_device_local_number_uq" ON "purchase_receipts" USING btree ("device_id","local_number") WHERE "purchase_receipts"."local_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipts_supplier_note_uq" ON "purchase_receipts" USING btree ("tenant_id","supplier_id","supplier_note_number") WHERE "purchase_receipts"."supplier_note_number" is not null and "purchase_receipts"."reversal_of_id" is null and "purchase_receipts"."status" <> 'reversed';--> statement-breakpoint
CREATE UNIQUE INDEX "reorder_items_live_uq" ON "reorder_items" USING btree ("outlet_id","product_id") WHERE "reorder_items"."status" in ('open', 'ordered');--> statement-breakpoint
CREATE INDEX "supplier_payment_alloc_receipt_idx" ON "supplier_payment_allocations" USING btree ("purchase_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_alloc_reversal_uq" ON "supplier_payment_allocations" USING btree ("reversal_of_id") WHERE "supplier_payment_allocations"."reversal_of_id" is not null;--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("supplier_id","business_date");--> statement-breakpoint
CREATE INDEX "suppliers_tenant_idx" ON "suppliers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_productions_source_date_uq" ON "daily_productions" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE INDEX "meter_adjustments_meter_date_idx" ON "meter_adjustments" USING btree ("water_meter_id","business_date");--> statement-breakpoint
CREATE INDEX "meter_adjustments_source_date_idx" ON "meter_adjustments" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_readings_meter_date_phase_uq" ON "meter_readings" USING btree ("water_meter_id","business_date","phase") WHERE "meter_readings"."superseded_by_id" is null;--> statement-breakpoint
CREATE INDEX "meter_readings_source_date_idx" ON "meter_readings" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "meter_readings_sync_command_uq" ON "meter_readings" USING btree ("sync_command_id") WHERE "meter_readings"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "quality_test_schedules_due_idx" ON "quality_test_schedules" USING btree ("next_due_date");--> statement-breakpoint
CREATE INDEX "quality_tests_location_idx" ON "quality_tests" USING btree ("location_type","water_source_id","outlet_id","test_date");--> statement-breakpoint
CREATE INDEX "tank_level_readings_source_date_idx" ON "tank_level_readings" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "tank_level_readings_sync_command_uq" ON "tank_level_readings" USING btree ("sync_command_id") WHERE "tank_level_readings"."sync_command_id" is not null;--> statement-breakpoint
CREATE INDEX "truck_fills_source_date_idx" ON "truck_fills" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE INDEX "truck_fills_trip_idx" ON "truck_fills" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "truck_fills_truck_date_idx" ON "truck_fills" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "truck_fills_trip_live_uq" ON "truck_fills" USING btree ("trip_id") WHERE "truck_fills"."trip_id" is not null and "truck_fills"."reversal_of_id" is null and "truck_fills"."reversed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "truck_fills_reversal_uq" ON "truck_fills" USING btree ("reversal_of_id") WHERE "truck_fills"."reversal_of_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "truck_fills_sync_command_uq" ON "truck_fills" USING btree ("sync_command_id") WHERE "truck_fills"."sync_command_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "water_balances_source_date_uq" ON "water_balances" USING btree ("water_source_id","business_date");--> statement-breakpoint
CREATE INDEX "water_balances_status_idx" ON "water_balances" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_summaries_tenant_date_uq" ON "daily_summaries" USING btree ("tenant_id","business_date");--> statement-breakpoint
CREATE INDEX "daily_summary_addenda_summary_idx" ON "daily_summary_addenda" USING btree ("daily_summary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kpi_manual_inputs_uq" ON "kpi_manual_inputs" USING btree ("tenant_id","kpi_code","period");--> statement-breakpoint
CREATE INDEX "parallel_run_checks_unit_date_idx" ON "parallel_run_checks" USING btree ("unit_type","truck_id","outlet_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "report_snapshots_uq" ON "report_snapshots" USING btree ("tenant_id","report_key","period","scope_key","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "report_snapshots_final_uq" ON "report_snapshots" USING btree ("tenant_id","report_key","period","scope_key") WHERE "report_snapshots"."status" = 'final' and "report_snapshots"."superseded_by_id" is null;--> statement-breakpoint
CREATE INDEX "unit_paper_withdrawals_unit_idx" ON "unit_paper_withdrawals" USING btree ("unit_type","truck_id","outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_periods_tenant_period_uq" ON "accounting_periods" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tenant_code_uq" ON "accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "accounts_type_idx" ON "accounts" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliations_account_period_uq" ON "bank_reconciliations" USING btree ("bank_account_id","period_id");--> statement-breakpoint
CREATE INDEX "cash_reconciliations_period_idx" ON "cash_reconciliations" USING btree ("period_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_allocation_runs_posted_uq" ON "cost_allocation_runs" USING btree ("period_id","kind") WHERE "cost_allocation_runs"."status" = 'posted';--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_entries_asset_period_uq" ON "depreciation_entries" USING btree ("fixed_asset_id","period_id") WHERE "depreciation_entries"."is_adjustment" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "event_account_mappings_uq" ON "event_account_mappings" USING btree ("tenant_id","event_key","entry_key","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "export_templates_tenant_key_version_uq" ON "export_templates" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_extras_asset_uq" ON "fixed_asset_extras" USING btree ("fixed_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_tenant_code_uq" ON "fixed_assets" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_journal_line_uq" ON "journal_lines" USING btree ("journal_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("account_id","profit_center");--> statement-breakpoint
CREATE INDEX "journal_lines_outlet_idx" ON "journal_lines" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_payable_settlements_uq" ON "journal_payable_settlements" USING btree ("payable_id","journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_payables_journal_uq" ON "journal_payables" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "journal_payables_due_idx" ON "journal_payables" USING btree ("tenant_id","status","due_date");--> statement-breakpoint
CREATE INDEX "journal_queue_status_idx" ON "journal_queue" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "journals_period_idx" ON "journals" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "journals_date_idx" ON "journals" USING btree ("tenant_id","journal_date");--> statement-breakpoint
CREATE INDEX "journals_source_idx" ON "journals" USING btree ("source_object_type","source_object_id");--> statement-breakpoint
CREATE INDEX "journals_source_event_idx" ON "journals" USING btree ("source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_auto_event_uq" ON "journals" USING btree ("source_event_id") WHERE "journals"."kind" = 'auto' and "journals"."source_event_id" is not null and "journals"."reversal_of_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "journals_tenant_number_uq" ON "journals" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_journal_details_journal_uq" ON "manual_journal_details" USING btree ("journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_journal_details_recurring_uq" ON "manual_journal_details" USING btree ("recurring_journal_id","recurring_period") WHERE "manual_journal_details"."recurring_journal_id" is not null;--> statement-breakpoint
CREATE INDEX "opening_balance_batches_group_idx" ON "opening_balance_batches" USING btree ("tenant_id","group");--> statement-breakpoint
CREATE INDEX "opening_balance_lines_batch_idx" ON "opening_balance_lines" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "period_review_notes_period_idx" ON "period_review_notes" USING btree ("period_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profit_centers_tenant_code_uq" ON "profit_centers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "recurring_journals_tenant_idx" ON "recurring_journals" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "retroactive_runs_tenant_idx" ON "retroactive_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_scheme_rates_setting_uq" ON "tax_scheme_rates" USING btree ("tax_setting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_settings_tenant_from_uq" ON "tax_settings" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE INDEX "fleet_events_truck_date_idx" ON "fleet_events" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "fleet_events_status_kind_idx" ON "fleet_events" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "fleet_events_trip_idx" ON "fleet_events" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_events_dedupe_uq" ON "fleet_events" USING btree ("tenant_id","dedupe_key") WHERE "fleet_events"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "fuel_estimates_truck_date_idx" ON "fuel_estimates" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "gps_positions_truck_time_idx" ON "gps_positions" USING btree ("truck_id","device_time");--> statement-breakpoint
CREATE INDEX "gps_positions_device_time_idx" ON "gps_positions" USING btree ("device_id","device_time");--> statement-breakpoint
CREATE INDEX "gps_positions_trip_idx" ON "gps_positions" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gps_positions_dedupe_uq" ON "gps_positions" USING btree ("truck_id","source","device_time");--> statement-breakpoint
CREATE INDEX "gps_positions_time_idx" ON "gps_positions" USING btree ("device_time");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_tracking_flags_live_uq" ON "phone_tracking_flags" USING btree ("truck_id") WHERE "phone_tracking_flags"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "truck_day_summaries_truck_date_uq" ON "truck_day_summaries" USING btree ("truck_id","business_date");--> statement-breakpoint
CREATE INDEX "complaint_actions_complaint_idx" ON "complaint_actions" USING btree ("complaint_id","created_at");--> statement-breakpoint
CREATE INDEX "complaints_status_idx" ON "complaints" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "complaints_customer_idx" ON "complaints" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_account_requests_status_idx" ON "customer_account_requests" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "customer_account_requests_account_idx" ON "customer_account_requests" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "customer_accounts_customer_idx" ON "customer_accounts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_app_orders_account_idx" ON "customer_app_orders" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "customer_app_orders_due_idx" ON "customer_app_orders" USING btree ("confirmed_at","confirm_due_at");--> statement-breakpoint
CREATE INDEX "customer_download_logs_account_idx" ON "customer_download_logs" USING btree ("customer_account_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_notifications_account_idx" ON "customer_notifications" USING btree ("customer_account_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_push_subscriptions_account_idx" ON "customer_push_subscriptions" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "customer_sessions_account_idx" ON "customer_sessions" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "otp_codes_phone_idx" ON "otp_codes" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_ip_idx" ON "otp_codes" USING btree ("request_ip","created_at");--> statement-breakpoint
CREATE INDEX "otp_codes_created_idx" ON "otp_codes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payment_intents_customer_idx" ON "payment_intents" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "phone_change_requests_account_idx" ON "phone_change_requests" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "wa_message_costs_month_idx" ON "wa_message_costs" USING btree ("tenant_id","month");--> statement-breakpoint
CREATE INDEX "exclusive_territories_contract_idx" ON "exclusive_territories" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_checklists_contract_item_uq" ON "onboarding_checklists" USING btree ("contract_id","item") WHERE "onboarding_checklists"."outlet_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_checklists_outlet_item_uq" ON "onboarding_checklists" USING btree ("contract_id","outlet_id","item") WHERE "onboarding_checklists"."outlet_id" is not null;--> statement-breakpoint
CREATE INDEX "partner_audits_outlet_idx" ON "partner_audits" USING btree ("outlet_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "partner_contracts_tenant_idx" ON "partner_contracts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_evaluations_contract_due_uq" ON "partner_evaluations" USING btree ("contract_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_monthly_reports_tenant_period_uq" ON "partner_monthly_reports" USING btree ("tenant_id","period");--> statement-breakpoint
CREATE INDEX "partner_portal_orders_tenant_idx" ON "partner_portal_orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_portal_orders_pos_sale_uq" ON "partner_portal_orders" USING btree ("pos_sale_id") WHERE "partner_portal_orders"."pos_sale_id" is not null;--> statement-breakpoint
CREATE INDEX "partner_prospects_status_idx" ON "partner_prospects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "partner_sanctions_contract_idx" ON "partner_sanctions" USING btree ("contract_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_scores_outlet_period_uq" ON "partner_scores" USING btree ("outlet_id","period");--> statement-breakpoint
CREATE INDEX "partner_support_requests_status_idx" ON "partner_support_requests" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "partner_surveys_prospect_idx" ON "partner_surveys" USING btree ("prospect_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_checklist_items_uq" ON "quality_checklist_items" USING btree ("checklist_id","item_key");--> statement-breakpoint
CREATE INDEX "quality_checklist_items_tenant_idx" ON "quality_checklist_items" USING btree ("tenant_id","checklist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_checklists_outlet_date_uq" ON "quality_checklists" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_checklists_sync_command_uq" ON "quality_checklists" USING btree ("sync_command_id") WHERE "quality_checklists"."sync_command_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "royalty_calculations_contract_period_uq" ON "royalty_calculations" USING btree ("contract_id","period");