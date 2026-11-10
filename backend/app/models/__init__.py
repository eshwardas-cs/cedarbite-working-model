# Import every model so Base.metadata (and Alembic) knows about all tables.
from app.models.audit import AuditLog  # noqa: F401
from app.models.email_token import EmailToken  # noqa: F401
from app.models.menu import MenuCategory, MenuItem, MenuItemOption  # noqa: F401
from app.models.orders import Order, OrderItem, OrderStatusHistory  # noqa: F401
from app.models.scheduling import AppSetting, PickupWindow  # noqa: F401
from app.models.session import UserSession  # noqa: F401
from app.models.user import Role, User  # noqa: F401
from app.models.wallet import WalletEntry  # noqa: F401
