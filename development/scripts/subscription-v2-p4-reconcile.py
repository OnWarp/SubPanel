#!/usr/bin/env python3
"""Compare offline D1 SQLite snapshots without displaying row contents."""

import argparse
import json
import sqlite3
from contextlib import closing
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"
TABLE_KEYS = {
    "users": ("id",),
    "subscriptions": ("id",),
    "subscription_groups": ("subscription_id", "group_id"),
    "subscription_nodes": ("subscription_id", "node_id"),
    "subscription_creation": ("subscription_id",),
    "subscription_template_bindings": ("subscription_id",),
    "plans": ("id",),
    "plan_groups": ("plan_id", "group_id"),
    "sources": ("id",),
    "nodes": ("id",),
    "node_raw_variants": ("id",),
}


def open_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def table_rows(db, table, keys):
    cursor = db.execute(f'SELECT * FROM "{table}"')
    columns = [column[0] for column in cursor.description]
    positions = [columns.index(key) for key in keys]
    return columns, {tuple(row[i] for i in positions): row for row in cursor}


def compare(before, after):
    report = {}
    for table, keys in TABLE_KEYS.items():
        old_columns, old = table_rows(before, table, keys)
        new_columns, new = table_rows(after, table, keys)
        common = old.keys() & new.keys()
        positions = [new_columns.index(column) for column in old_columns]
        report[table] = {
            "before": len(old),
            "after": len(new),
            "added": len(new.keys() - old.keys()),
            "missing": len(old.keys() - new.keys()),
            "changed": sum(old[key] != tuple(new[key][i] for i in positions) for key in common),
        }
    return report


def quality(db):
    duplicate_tokens = db.execute(
        "SELECT count(*) - count(DISTINCT token_hash) FROM subscriptions"
    ).fetchone()[0]
    return {
        "duplicate_or_missing_token_hashes": duplicate_tokens,
        "foreign_key_violations": sum(1 for _ in db.execute("PRAGMA foreign_key_check")),
        "assigned_subscriptions": db.execute("SELECT count(user_id) FROM subscriptions").fetchone()[0],
        "legacy_quota_gib": db.execute("SELECT coalesce(sum(traffic_gb),0) FROM subscriptions").fetchone()[0],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", help="Offline SQLite baseline at 0022 or later")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--compare", help="Offline SQLite candidate")
    mode.add_argument("--simulate-from-0022", action="store_true")
    args = parser.parse_args()
    with closing(open_readonly(args.before)) as before:
        with closing(open_readonly(args.compare) if args.compare else sqlite3.connect(":memory:")) as after:
            if args.simulate_from_0022:
                before.backup(after)
                after.execute("PRAGMA foreign_keys=ON")
                for prefix in ("0023", "0024"):
                    migration, = MIGRATIONS.glob(f"{prefix}_*.sql")
                    after.executescript(migration.read_text())
            tables = compare(before, after)
            checks = quality(after)
            print(json.dumps({"tables": tables, "quality": checks}, indent=2))
            return int(
                any(any(row[key] for key in ("added", "missing", "changed")) for row in tables.values())
                or checks["duplicate_or_missing_token_hashes"] != 0
                or checks["foreign_key_violations"] != 0
            )


if __name__ == "__main__":
    raise SystemExit(main())
