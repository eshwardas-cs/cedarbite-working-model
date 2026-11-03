"""Who may do what. Checked on the SERVER for every protected endpoint.

These are defaults. The college admin deliberately gets aggregate reports and
policy controls only: no payment settings, no individual students' orders.
"""
from enum import Enum

from app.auth.roles import Role


class Permission(str, Enum):
    MENU_VIEW = "menu.view"
    MENU_MANAGE = "menu.manage"
    AVAILABILITY_TOGGLE = "availability.toggle"
    ORDERS_CREATE = "orders.create"
    ORDERS_VIEW_OWN = "orders.view_own"
    ORDERS_VIEW_ALL = "orders.view_all"
    QUEUE_VIEW = "queue.view"
    ORDERS_FULFIL = "orders.fulfil"
    ORDERS_CANCEL = "orders.cancel"
    ORDERING_PAUSE = "ordering.pause"
    WINDOWS_MANAGE = "windows.manage"
    REFUNDS_REQUEST = "refunds.request"
    REFUNDS_APPROVE = "refunds.approve"
    REPORTS_VIEW_AGGREGATE = "reports.view_aggregate"
    REPORTS_EXPORT = "reports.export"
    STAFF_MANAGE = "staff.manage"
    SETTINGS_MANAGE = "settings.manage"
    PAYMENT_CONFIG = "payment.config"
    WALLET_CASH_TOPUP = "wallet.cash_topup"
    COLLEGE_POLICY_MANAGE = "college.policy_manage"
    AUDIT_VIEW = "audit.view"
    OWNERSHIP_TRANSFER = "ownership.transfer"


P = Permission
_CUSTOMER = frozenset({P.MENU_VIEW, P.ORDERS_CREATE, P.ORDERS_VIEW_OWN, P.REFUNDS_REQUEST})
_STAFF = frozenset({P.MENU_VIEW, P.QUEUE_VIEW, P.ORDERS_FULFIL, P.AVAILABILITY_TOGGLE, P.ORDERING_PAUSE})
_MANAGER = _STAFF | frozenset({P.MENU_MANAGE, P.WINDOWS_MANAGE, P.ORDERS_VIEW_ALL, P.ORDERS_CANCEL,
                               P.REFUNDS_APPROVE, P.REPORTS_VIEW_AGGREGATE, P.WALLET_CASH_TOPUP})
_COLLEGE_ADMIN = frozenset({P.REPORTS_VIEW_AGGREGATE, P.COLLEGE_POLICY_MANAGE, P.AUDIT_VIEW})

ROLE_PERMISSIONS: dict[Role, frozenset] = {
    Role.STUDENT: _CUSTOMER,
    Role.STAFF_CUSTOMER: _CUSTOMER,
    Role.STAFF: _STAFF,
    Role.MANAGER: _MANAGER,
    Role.COLLEGE_ADMIN: _COLLEGE_ADMIN,
    Role.OWNER: frozenset(Permission),
}


def has_permission(role: Role, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS.get(role, frozenset())


def can_assign_role(actor: Role, target: Role) -> bool:
    """Only the owner assigns roles, and nobody gets OWNER this way:
    ownership only moves through the audited transfer."""
    return actor == Role.OWNER and target != Role.OWNER
