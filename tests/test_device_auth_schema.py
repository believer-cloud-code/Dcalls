import sqlite3
import unittest
from pathlib import Path


MIGRATION = Path(__file__).parents[1] / "cloudflare" / "migrations" / "0001_trusted_device_control_plane.sql"


class TrustedDeviceSchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(MIGRATION.read_text(encoding="utf-8"))
        self.db.execute(
            """INSERT INTO account_identities
               (uid, matrix_user_id, master_key_json, self_signing_key_json,
                user_signing_key_json, signatures_json, created_at, updated_at)
               VALUES (?, ?, '{}', '{}', '{}', '{}', 1, 1)""",
            ("alice", "@alice:dcalls.local"),
        )
        self.db.execute(
            """INSERT INTO device_credentials
               (uid, device_id, matrix_user_id, ed25519_key, device_keys_json,
                status, created_at, updated_at)
               VALUES (?, ?, ?, ?, '{}', 'active', 1, 1)""",
            ("alice", "DEVICE_A", "@alice:dcalls.local", "public-key"),
        )

    def tearDown(self):
        self.db.close()

    def test_device_id_is_unique_per_account(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO device_credentials
                   (uid, device_id, matrix_user_id, ed25519_key, device_keys_json,
                    status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, '{}', 'active', 1, 1)""",
                ("alice", "DEVICE_A", "@alice:dcalls.local", "different-key"),
            )

    def test_revocation_state_is_constrained(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """UPDATE device_credentials SET status = 'reactivated'
                   WHERE uid = 'alice' AND device_id = 'DEVICE_A'"""
            )

    def test_one_time_key_cannot_be_duplicated(self):
        row = ("alice", "DEVICE_A", "signed_curve25519:key-1", "signed_curve25519", "{}", 1)
        self.db.execute(
            """INSERT INTO one_time_keys
               (uid, device_id, key_id, algorithm, key_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""", row
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO one_time_keys
                   (uid, device_id, key_id, algorithm, key_json, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""", row
            )

    def test_one_time_key_claim_is_single_use(self):
        self.db.execute(
            """INSERT INTO one_time_keys
               (uid, device_id, key_id, algorithm, key_json, created_at)
               VALUES ('alice', 'DEVICE_A', 'signed_curve25519:key-2',
                       'signed_curve25519', '{}', 1)"""
        )
        first = self.db.execute(
            """UPDATE one_time_keys SET claimed_by = 'bob', chat_id = 'chat-1', claimed_at = 2
               WHERE uid = 'alice' AND device_id = 'DEVICE_A'
                 AND key_id = 'signed_curve25519:key-2' AND claimed_by IS NULL"""
        )
        second = self.db.execute(
            """UPDATE one_time_keys SET claimed_by = 'mallory', chat_id = 'chat-2', claimed_at = 3
               WHERE uid = 'alice' AND device_id = 'DEVICE_A'
                 AND key_id = 'signed_curve25519:key-2' AND claimed_by IS NULL"""
        )
        self.assertEqual(first.rowcount, 1)
        self.assertEqual(second.rowcount, 0)

    def test_fallback_key_can_be_consumed_only_once(self):
        self.db.execute(
            """INSERT INTO fallback_keys
               (uid, device_id, key_id, algorithm, key_json, created_at)
               VALUES ('alice', 'DEVICE_A', 'signed_curve25519:fallback-1',
                       'signed_curve25519', '{}', 1)"""
        )
        usage = ("alice", "DEVICE_A", "signed_curve25519:fallback-1", "chat-1", "bob", 2)
        self.db.execute(
            """INSERT OR IGNORE INTO fallback_key_usage
               (uid, device_id, key_id, chat_id, claimed_by, used_at)
               VALUES (?, ?, ?, ?, ?, ?)""", usage
        )
        self.assertEqual(self.db.execute("SELECT changes()").fetchone()[0], 1)
        self.db.execute(
            """INSERT OR IGNORE INTO fallback_key_usage
               (uid, device_id, key_id, chat_id, claimed_by, used_at)
               VALUES (?, ?, ?, ?, ?, ?)""", usage
        )
        self.assertEqual(self.db.execute("SELECT changes()").fetchone()[0], 0)

    def test_inbox_event_id_is_unique_for_recipient_device(self):
        row = ("alice", "DEVICE_A", "event-1", "alice", "DEVICE_A", "chat-1", "ciphertext", "matrix-olm-megolm", 1)
        self.db.execute(
            """INSERT INTO encrypted_device_inbox
               (recipient_uid, recipient_device_id, event_id, sender_uid,
                sender_device_id, chat_id, payload, protocol, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", row
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO encrypted_device_inbox
                   (recipient_uid, recipient_device_id, event_id, sender_uid,
                    sender_device_id, chat_id, payload, protocol, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", row
            )

    def test_inbox_retry_does_not_replace_existing_ciphertext(self):
        row = ("alice", "DEVICE_A", "event-retry", "alice", "DEVICE_A",
               "chat-1", "original-ciphertext", "matrix-olm-megolm", 1)
        self.db.execute(
            """INSERT OR IGNORE INTO encrypted_device_inbox
               (recipient_uid, recipient_device_id, event_id, sender_uid,
                sender_device_id, chat_id, payload, protocol, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", row
        )
        changed = list(row)
        changed[6] = "tampered-ciphertext"
        self.db.execute(
            """INSERT OR IGNORE INTO encrypted_device_inbox
               (recipient_uid, recipient_device_id, event_id, sender_uid,
                sender_device_id, chat_id, payload, protocol, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", tuple(changed)
        )
        stored = self.db.execute(
            """SELECT payload FROM encrypted_device_inbox
               WHERE recipient_uid = 'alice' AND recipient_device_id = 'DEVICE_A'
                 AND event_id = 'event-retry'"""
        ).fetchone()
        self.assertEqual(stored[0], "original-ciphertext")

    def test_inbox_acknowledgement_is_scoped_to_recipient_device(self):
        self.db.execute(
            """INSERT INTO device_credentials
               (uid, device_id, matrix_user_id, ed25519_key, device_keys_json,
                status, created_at, updated_at)
               VALUES ('alice', 'DEVICE_B', '@alice:dcalls.local', 'public-key-b', '{}', 'active', 1, 1)"""
        )
        rows = [
            ("alice", "DEVICE_A", "same-event", "bob", "DEVICE_B", "chat-1", "cipher-a", "matrix-olm-megolm", 1),
            ("alice", "DEVICE_B", "same-event", "bob", "DEVICE_B", "chat-1", "cipher-b", "matrix-olm-megolm", 1),
        ]
        self.db.executemany(
            """INSERT INTO encrypted_device_inbox
               (recipient_uid, recipient_device_id, event_id, sender_uid,
                sender_device_id, chat_id, payload, protocol, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""", rows
        )
        self.db.execute(
            """DELETE FROM encrypted_device_inbox
               WHERE recipient_uid = 'alice' AND recipient_device_id = 'DEVICE_A'
                 AND chat_id = 'chat-1' AND event_id = 'same-event'"""
        )
        remaining = self.db.execute(
            """SELECT recipient_device_id, payload FROM encrypted_device_inbox
               WHERE event_id = 'same-event'"""
        ).fetchall()
        self.assertEqual(remaining, [("DEVICE_B", "cipher-b")])

    def test_device_link_messages_are_immutable_per_session_message_type(self):
        self.db.execute(
            """INSERT INTO device_link_sessions
               (owner_uid, session_id, source_device_id, hpke_public_key,
                state, expires_at, created_at, updated_at)
               VALUES ('alice', 'aabbccddeeff00112233445566778899',
                       'DEVICE_A', 'hpke-public-key', 'waiting', 300000, 1, 1)"""
        )
        row = ("alice", "aabbccddeeff00112233445566778899", "join", "DEVICE_B", "ciphertext", 2)
        self.db.execute(
            """INSERT INTO device_link_messages
               (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""", row
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO device_link_messages
                   (owner_uid, session_id, message_id, sender_device_id, ciphertext, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                ("alice", "aabbccddeeff00112233445566778899", "join", "DEVICE_C", "different", 3),
            )

    def test_device_link_session_states_are_constrained(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO device_link_sessions
                   (owner_uid, session_id, source_device_id, hpke_public_key,
                    state, expires_at, created_at, updated_at)
                   VALUES ('alice', 'session-1', 'DEVICE_A', 'key', 'complete', 10, 1, 1)"""
            )

    def test_device_counter_uses_compare_and_swap(self):
        first = self.db.execute(
            """UPDATE device_credentials SET last_counter = 1
               WHERE uid = 'alice' AND device_id = 'DEVICE_A'
                 AND status = 'active' AND last_counter = 0"""
        )
        self.assertEqual(first.rowcount, 1)
        replay = self.db.execute(
            """UPDATE device_credentials SET last_counter = 1
               WHERE uid = 'alice' AND device_id = 'DEVICE_A'
                 AND status = 'active' AND last_counter = 0"""
        )
        self.assertEqual(replay.rowcount, 0)

    def test_device_request_id_cannot_be_consumed_twice(self):
        values = ("alice", "DEVICE_A", "request-unique-0001", "inbox.send", 100)
        self.db.execute(
            """INSERT OR IGNORE INTO consumed_device_requests
               (uid, device_id, request_id, action, consumed_at)
               VALUES (?, ?, ?, ?, ?)""", values
        )
        self.assertEqual(self.db.execute("SELECT changes()").fetchone()[0], 1)
        self.db.execute(
            """INSERT OR IGNORE INTO consumed_device_requests
               (uid, device_id, request_id, action, consumed_at)
               VALUES (?, ?, ?, ?, ?)""", values
        )
        self.assertEqual(self.db.execute("SELECT changes()").fetchone()[0], 0)

    def test_unknown_device_cannot_own_inbox_events(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                """INSERT INTO encrypted_device_inbox
                   (recipient_uid, recipient_device_id, event_id, sender_uid,
                    sender_device_id, chat_id, payload, protocol, created_at)
                   VALUES ('alice', 'UNKNOWN', 'event-2', 'alice', 'DEVICE_A',
                           'chat-1', 'ciphertext', 'matrix-olm-megolm', 1)"""
            )


if __name__ == "__main__":
    unittest.main()
