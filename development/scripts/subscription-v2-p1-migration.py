#!/usr/bin/env python3
"""Simulate 0021 on an in-memory copy of a local SQLite snapshot."""

import argparse
import json
import sqlite3
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[2] / "migrations/0021_subscription_v2_p1.sql"


def connect_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def snapshot(db):
    subscriptions = {
        row[0]: row[1:]
        for row in db.execute("SELECT id, subscriptions.* FROM subscriptions")
    }
    groups = set(db.execute("SELECT subscription_id, group_id, position FROM subscription_groups"))
    return subscriptions, groups


def stats(db):
    count, unassigned, distinct_tokens, quota_total = db.execute(
        """SELECT count(*), count(*) - count(user_id), count(DISTINCT token_hash),
                  coalesce(sum(traffic_gb), 0) FROM subscriptions"""
    ).fetchone()
    legacy = None
    if schema_exists(db):
        legacy = db.execute(
            """SELECT count(*) FROM subscriptions s
               LEFT JOIN subscription_creation c ON c.subscription_id=s.id
               WHERE coalesce(c.source_type, 'legacy')='legacy'"""
        ).fetchone()[0]
    return {
        "subscriptions": count,
        "unassigned": unassigned,
        "distinct_token_hashes": distinct_tokens,
        "quota_total_gib": quota_total,
        "group_references": db.execute("SELECT count(*) FROM subscription_groups").fetchone()[0],
        "effective_legacy": legacy,
    }


def schema_exists(db):
    return db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='subscription_creation'"
    ).fetchone() is not None


def differences(before, after):
    old_rows, old_groups = before
    new_rows, new_groups = after
    return {
        "subscriptions_added": len(new_rows.keys() - old_rows.keys()),
        "subscriptions_removed": len(old_rows.keys() - new_rows.keys()),
        "subscriptions_changed": sum(old_rows[key] != new_rows[key] for key in old_rows.keys() & new_rows.keys()),
        "group_references_added": len(new_groups - old_groups),
        "group_references_removed": len(old_groups - new_groups),
    }


def metadata(db):
    return db.execute("SELECT * FROM subscription_creation ORDER BY rowid").fetchall()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", required=True, metavar="LOCAL_SQLITE")
    parser.add_argument("--compare", metavar="MIGRATED_SQLITE", help="Check the independently migrated local copy")
    options = parser.parse_args()
    with connect_readonly(options.dry_run) as source, sqlite3.connect(":memory:") as dry_run:
        source.backup(dry_run)
        dry_run.execute("PRAGMA foreign_keys=ON")
        before = snapshot(dry_run)
        before_stats = stats(dry_run)
        sql = MIGRATION.read_text()
        dry_run.executescript(sql)
        after = snapshot(dry_run)
        after_stats = stats(dry_run)
        after_metadata = metadata(dry_run)
        dry_run.executescript(sql)
        replay_matches = snapshot(dry_run) == after and metadata(dry_run) == after_metadata
        report = {
            "mode": "dry-run",
            "before": before_stats,
            "after": after_stats,
            "diff": differences(before, after),
            "replay_matches": replay_matches,
            "metadata_foreign_key_violations": len(dry_run.execute(
                "PRAGMA foreign_key_check(subscription_creation)"
            ).fetchall()),
        }
        if options.compare:
            with connect_readonly(options.compare) as migrated:
                report["local_diff"] = differences(after, snapshot(migrated))
                report["local_matches_dry_run"] = (
                    schema_exists(migrated) and stats(migrated) == after_stats
                    and metadata(migrated) == after_metadata and not any(report["local_diff"].values())
                )
    print(json.dumps(report, indent=2))
    return int(
        any(report["diff"].values()) or not replay_matches
        or bool(report["metadata_foreign_key_violations"])
        or not report.get("local_matches_dry_run", True)
    )


if __name__ == "__main__":
    raise SystemExit(main())
