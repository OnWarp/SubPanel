#!/usr/bin/env python3
"""Simulate 0023 on a read-only local SQLite snapshot and report data differences."""

import argparse
import json
import sqlite3
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[2] / "migrations/0023_subscription_v2_p3.sql"
P3_TABLES = (
    "redemption_batches", "redemption_codes", "redemption_records",
)


def connect_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def schema(db):
    return {
        (kind, name): sql
        for kind, name, sql in db.execute(
            "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL"
        )
        if not name.startswith(("sqlite_", "_cf_"))
    }


def snapshot(db, tables):
    result = {}
    for name in tables:
        quoted = '"' + name.replace('"', '""') + '"'
        columns = sorted((pk, index) for index, _, _, _, _, pk in db.execute(
            f"PRAGMA table_info({quoted})"
        ) if pk)
        result[name] = {
            tuple(row[index] for _, index in columns) if columns else row[0]: row[1:] if not columns else row
            for row in db.execute(f"SELECT {'*' if columns else 'rowid, *'} FROM {quoted}")
        }
    return result


def difference(before, after):
    result = {}
    for table, rows in before.items():
        current = after[table]
        changed = {
            "added": len(current.keys() - rows.keys()),
            "removed": len(rows.keys() - current.keys()),
            "changed": sum(rows[key] != current[key] for key in rows.keys() & current.keys()),
        }
        if any(changed.values()):
            result[table] = changed
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", required=True, metavar="LOCAL_SQLITE")
    parser.add_argument("--compare", metavar="MIGRATED_SQLITE", help="Check an independently migrated local copy")
    options = parser.parse_args()
    with sqlite3.connect(":memory:") as db:
        with connect_readonly(options.dry_run) as source:
            source.backup(db)
        db.execute("PRAGMA foreign_keys=ON")
        old_schema = schema(db)
        tables = [name for kind, name in old_schema if kind == "table"]
        before = snapshot(db, tables)
        violations = set(db.execute("PRAGMA foreign_key_check"))
        sql = MIGRATION.read_text()
        db.executescript(sql)
        new_schema = schema(db)
        all_tables = [name for kind, name in new_schema if kind == "table"]
        after = snapshot(db, all_tables)
        db.executescript(sql)
        count_tables = ("subscriptions", "subscription_groups", "subscription_creation", *P3_TABLES)
        report = {
            "mode": "dry-run",
            "rows_before": {name: len(before[name]) if name in before else None for name in count_tables},
            "rows_after": {name: len(after[name]) for name in count_tables},
            "schema_added": sorted(f"{kind} {name}" for kind, name in new_schema.keys() - old_schema.keys()),
            "existing_schema_changed": sorted(name for key in old_schema if old_schema[key] != new_schema.get(key) for _, name in [key]),
            "existing_rows_changed": difference(before, after),
            "new_foreign_key_violations": len(set(db.execute("PRAGMA foreign_key_check")) - violations),
            "replay_matches": schema(db) == new_schema and snapshot(db, all_tables) == after,
        }
        if options.compare:
            with connect_readonly(options.compare) as migrated:
                report["local_matches_dry_run"] = (
                    schema(migrated) == new_schema and snapshot(migrated, all_tables) == after
                )
    print(json.dumps(report, indent=2))
    return int(
        bool(report["existing_schema_changed"] or report["existing_rows_changed"] or report["new_foreign_key_violations"])
        or not report["replay_matches"] or not report.get("local_matches_dry_run", True)
    )


if __name__ == "__main__":
    raise SystemExit(main())
