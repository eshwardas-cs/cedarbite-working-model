import unittest

from app.auth.email_policy import email_domain_allowed, normalize_email
from app.auth.permissions import Permission as P, ROLE_PERMISSIONS, can_assign_role, has_permission
from app.auth.roles import Role
from app.auth.throttle import LoginThrottle


class PermissionTests(unittest.TestCase):
    def test_every_role_has_an_entry(self):
        self.assertEqual(set(ROLE_PERMISSIONS), set(Role))

    def test_owner_has_everything(self):
        for p in P:
            self.assertTrue(has_permission(Role.OWNER, p), p)

    def test_students_cannot_do_admin_things(self):
        for p in (P.PAYMENT_CONFIG, P.MENU_MANAGE, P.ORDERS_VIEW_ALL, P.STAFF_MANAGE,
                  P.ORDERS_FULFIL, P.REFUNDS_APPROVE, P.OWNERSHIP_TRANSFER, P.AUDIT_VIEW):
            self.assertFalse(has_permission(Role.STUDENT, p), p)

    def test_students_can_order_and_see_own_orders(self):
        for p in (P.MENU_VIEW, P.ORDERS_CREATE, P.ORDERS_VIEW_OWN):
            self.assertTrue(has_permission(Role.STUDENT, p), p)

    def test_staff_cannot_touch_payments_or_roles(self):
        for p in (P.PAYMENT_CONFIG, P.STAFF_MANAGE, P.SETTINGS_MANAGE, P.REPORTS_EXPORT,
                  P.OWNERSHIP_TRANSFER, P.MENU_MANAGE):
            self.assertFalse(has_permission(Role.STAFF, p), p)

    def test_manager_cannot_touch_payment_config_or_ownership(self):
        self.assertFalse(has_permission(Role.MANAGER, P.PAYMENT_CONFIG))
        self.assertFalse(has_permission(Role.MANAGER, P.OWNERSHIP_TRANSFER))

    def test_college_admin_sees_aggregates_not_individuals_or_payments(self):
        self.assertTrue(has_permission(Role.COLLEGE_ADMIN, P.REPORTS_VIEW_AGGREGATE))
        self.assertTrue(has_permission(Role.COLLEGE_ADMIN, P.COLLEGE_POLICY_MANAGE))
        for p in (P.ORDERS_VIEW_ALL, P.ORDERS_VIEW_OWN, P.PAYMENT_CONFIG, P.OWNERSHIP_TRANSFER,
                  P.REFUNDS_APPROVE, P.ORDERS_FULFIL):
            self.assertFalse(has_permission(Role.COLLEGE_ADMIN, p), p)

    def test_only_owner_assigns_roles_and_nobody_assigns_owner(self):
        self.assertTrue(can_assign_role(Role.OWNER, Role.MANAGER))
        self.assertFalse(can_assign_role(Role.OWNER, Role.OWNER))
        for actor in (Role.MANAGER, Role.COLLEGE_ADMIN, Role.STAFF, Role.STUDENT):
            self.assertFalse(can_assign_role(actor, Role.STAFF), actor)
            self.assertFalse(can_assign_role(actor, Role.OWNER), actor)


class EmailPolicyTests(unittest.TestCase):
    def test_allows_exact_domain_case_insensitive(self):
        self.assertTrue(email_domain_allowed("Ali@Example.edu.pk ", "example.edu.pk"))

    def test_rejects_other_or_lookalike_domains(self):
        for e in ("a@gmail.com", "a@evil-example.edu.pk", "a@example.edu.pk.evil.com",
                  "a@sub.example.edu.pk"):
            self.assertFalse(email_domain_allowed(e, "example.edu.pk"), e)

    def test_rejects_malformed(self):
        for e in ("", "no-at-sign", "@example.edu.pk", "a@b@example.edu.pk"):
            self.assertFalse(email_domain_allowed(e, "example.edu.pk"), e)

    def test_fails_closed_when_no_domain_configured(self):
        self.assertFalse(email_domain_allowed("a@example.edu.pk", ""))

    def test_normalize(self):
        self.assertEqual(normalize_email("  A@B.com "), "a@b.com")


class ThrottleTests(unittest.TestCase):
    def test_blocks_after_limit_and_expires(self):
        now = [0.0]
        t = LoginThrottle(max_failures=3, window_seconds=100, clock=lambda: now[0])
        for _ in range(3):
            self.assertFalse(t.blocked("k"))
            t.record_failure("k")
        self.assertTrue(t.blocked("k"))
        now[0] = 101
        self.assertFalse(t.blocked("k"))

    def test_keys_are_independent_and_reset_works(self):
        t = LoginThrottle(max_failures=1)
        t.record_failure("a")
        self.assertTrue(t.blocked("a"))
        self.assertFalse(t.blocked("b"))
        t.reset("a")
        self.assertFalse(t.blocked("a"))


if __name__ == "__main__":
    unittest.main()
