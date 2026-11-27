-- Run before cutover only. Dropping each new table also drops its indexes.
DROP TABLE IF EXISTS legacy_subscription_routes;
DROP TABLE IF EXISTS redemptions;
DROP TABLE IF EXISTS redeem_codes;
DROP TABLE IF EXISTS subscription_tokens;
DROP TABLE IF EXISTS user_plans;
DROP TABLE IF EXISTS plan_node_groups;
DROP TABLE IF EXISTS plan_definitions;
