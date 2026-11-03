import unittest

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.auth.roles import Role
from app.auth.service import (AuthError, authenticate, create_owner, create_user, transfer_ownership)
from app.auth.sessions import create_session, get_user_for_token, revoke_session
from app.db.base import Base, make_engine, make_session_factory
from app.models import AuditLog, User

PW = "a-good-password-1"


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = make_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = make_session_factory(self.engine)()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_owner_created_once_only(self):
        create_owner(self.db, "owner@example.edu.pk", PW)
        with self.assertRaises(AuthError):
            create_owner(self.db, "second@example.edu.pk", PW)

    def test_create_user_cannot_make_an_owner(self):
        with self.assertRaises(AuthError):
            create_user(self.db, "x@example.edu.pk", PW, Role.OWNER)

    def test_duplicate_email_is_a_friendly_error(self):
        create_user(self.db, "a@example.edu.pk", PW)
        with self.assertRaises(AuthError):
            create_user(self.db, "A@example.edu.pk", PW)

    def test_database_blocks_two_active_owners(self):
        create_owner(self.db, "owner@example.edu.pk", PW)
        self.db.add(User(email="sneaky@example.edu.pk", password_hash="x", role=Role.OWNER))
        with self.assertRaises(IntegrityError):
            self.db.commit()

    def test_authenticate(self):
        create_user(self.db, "a@example.edu.pk", PW)
        self.assertIsNotNone(authenticate(self.db, " A@example.edu.pk", PW))
        self.assertIsNone(authenticate(self.db, "a@example.edu.pk", "wrong-password-1"))
        self.assertIsNone(authenticate(self.db, "nobody@example.edu.pk", PW))

    def test_disabled_account_cannot_authenticate(self):
        u = create_user(self.db, "a@example.edu.pk", PW)
        u.is_active = False
        self.db.commit()
        self.assertIsNone(authenticate(self.db, "a@example.edu.pk", PW))

    def test_session_lifecycle(self):
        u = create_user(self.db, "a@example.edu.pk", PW)
        token = create_session(self.db, u)
        self.assertEqual(get_user_for_token(self.db, token).id, u.id)
        self.assertIsNone(get_user_for_token(self.db, "garbage"))
        revoke_session(self.db, token)
        self.assertIsNone(get_user_for_token(self.db, token))

    def test_session_dies_when_account_disabled(self):
        u = create_user(self.db, "a@example.edu.pk", PW)
        token = create_session(self.db, u)
        u.is_active = False
        self.db.commit()
        self.assertIsNone(get_user_for_token(self.db, token))

    def test_ownership_transfer(self):
        owner = create_owner(self.db, "dev@example.edu.pk", PW)
        canteen = create_user(self.db, "canteen@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        transfer_ownership(self.db, owner, "canteen@example.edu.pk", Role.COLLEGE_ADMIN)
        self.db.expire_all()
        self.assertEqual(self.db.get(User, canteen.id).role, Role.OWNER)
        self.assertEqual(self.db.get(User, owner.id).role, Role.COLLEGE_ADMIN)
        log = self.db.scalar(select(AuditLog).where(AuditLog.action == "ownership.transferred"))
        self.assertEqual(log.actor_user_id, owner.id)
        self.assertEqual(log.target_id, canteen.id)

    def test_transfer_refused_cases(self):
        owner = create_owner(self.db, "dev@example.edu.pk", PW)
        create_user(self.db, "unverified@example.edu.pk", PW, Role.MANAGER, email_verified=False)
        off = create_user(self.db, "off@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        off.is_active = False
        self.db.commit()
        for email in ("unverified@example.edu.pk", "off@example.edu.pk",
                      "missing@example.edu.pk", "dev@example.edu.pk"):
            with self.assertRaises(AuthError, msg=email):
                transfer_ownership(self.db, owner, email, Role.STAFF)
        self.db.refresh(owner)
        self.assertEqual(owner.role, Role.OWNER)   # nothing changed

    def test_non_owner_cannot_transfer(self):
        create_owner(self.db, "dev@example.edu.pk", PW)
        mgr = create_user(self.db, "m@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        create_user(self.db, "n@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        with self.assertRaises(AuthError):
            transfer_ownership(self.db, mgr, "n@example.edu.pk", Role.STAFF)

    def test_old_owner_cannot_stay_owner(self):
        owner = create_owner(self.db, "dev@example.edu.pk", PW)
        create_user(self.db, "c@example.edu.pk", PW, Role.MANAGER, email_verified=True)
        with self.assertRaises(AuthError):
            transfer_ownership(self.db, owner, "c@example.edu.pk", Role.OWNER)


if __name__ == "__main__":
    unittest.main()
