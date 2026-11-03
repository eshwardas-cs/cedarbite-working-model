from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.service import audit
from app.core.money import format_pkr
from app.models.menu import MenuCategory, MenuItem
from app.models.user import User


class MenuError(Exception):
    """Safe to show to the person."""


class NotFound(MenuError):
    pass


EDITABLE = {"category_id", "name", "description", "price_paisa", "quick_allowed",
            "scheduled_allowed", "prep_minutes"}


def item_dict(i: MenuItem) -> dict:
    return {"id": i.id, "category_id": i.category_id, "name": i.name, "description": i.description,
            "price_paisa": i.price_paisa, "price_display": format_pkr(i.price_paisa),
            "available": bool(i.is_active and i.is_available), "is_active": i.is_active,
            "quick_allowed": i.quick_allowed, "scheduled_allowed": i.scheduled_allowed,
            "prep_minutes": i.prep_minutes}


def list_menu(db: Session, include_inactive: bool = False) -> list[dict]:
    out = []
    cats = db.scalars(select(MenuCategory).order_by(MenuCategory.sort_order, MenuCategory.id)).all()
    for c in cats:
        items = [i for i in sorted(c.items, key=lambda i: (i.name.lower(), i.id))
                 if include_inactive or i.is_active]
        if items or include_inactive:
            out.append({"id": c.id, "name": c.name, "items": [item_dict(i) for i in items]})
    return out


def create_category(db: Session, actor: User, name: str, sort_order: int = 0) -> MenuCategory:
    name = name.strip()
    if not name:
        raise MenuError("Category name is required.")
    if db.scalar(select(MenuCategory.id).where(MenuCategory.name == name)) is not None:
        raise MenuError("A category with that name already exists.")
    cat = MenuCategory(name=name, sort_order=sort_order)
    db.add(cat)
    db.flush()
    audit(db, actor.id, "menu.category_created", "menu_category", cat.id)
    db.commit()
    return cat


def _check_modes(quick: bool, scheduled: bool) -> None:
    if not (quick or scheduled):
        raise MenuError("Allow at least one of quick or scheduled ordering.")


def create_item(db: Session, actor: User, *, category_id: int, name: str, description: str = "",
                price_paisa: int, quick_allowed: bool = False, scheduled_allowed: bool = True,
                prep_minutes: int | None = None) -> MenuItem:
    if db.get(MenuCategory, category_id) is None:
        raise MenuError("Category not found.")
    name = name.strip()
    if not name:
        raise MenuError("Item name is required.")
    if price_paisa < 0:
        raise MenuError("Price cannot be negative.")
    _check_modes(quick_allowed, scheduled_allowed)
    item = MenuItem(category_id=category_id, name=name, description=description.strip(),
                    price_paisa=price_paisa, quick_allowed=quick_allowed,
                    scheduled_allowed=scheduled_allowed, prep_minutes=prep_minutes)
    db.add(item)
    db.flush()
    audit(db, actor.id, "menu.item_created", "menu_item", item.id, f"price_paisa={price_paisa}")
    db.commit()
    return item


def _get_item(db: Session, item_id: int) -> MenuItem:
    item = db.get(MenuItem, item_id)
    if item is None:
        raise NotFound("Item not found.")
    return item


def update_item(db: Session, actor: User, item_id: int, changes: dict) -> MenuItem:
    item = _get_item(db, item_id)
    unknown = set(changes) - EDITABLE
    if unknown:
        raise MenuError(f"Cannot change: {', '.join(sorted(unknown))}.")
    for key, value in changes.items():
        if value is None and key != "prep_minutes":
            raise MenuError(f"{key} cannot be empty.")
    if "category_id" in changes and db.get(MenuCategory, changes["category_id"]) is None:
        raise MenuError("Category not found.")
    if changes.get("price_paisa", 0) < 0:
        raise MenuError("Price cannot be negative.")
    _check_modes(changes.get("quick_allowed", item.quick_allowed),
                 changes.get("scheduled_allowed", item.scheduled_allowed))
    old_price = item.price_paisa
    for key, value in changes.items():
        setattr(item, key, value.strip() if isinstance(value, str) else value)
    if "name" in changes and not item.name:
        db.rollback()
        raise MenuError("Item name is required.")
    if item.price_paisa != old_price:
        audit(db, actor.id, "menu.price_changed", "menu_item", item.id,
              f"{old_price} -> {item.price_paisa} paisa")
    else:
        audit(db, actor.id, "menu.item_updated", "menu_item", item.id, ", ".join(sorted(changes)))
    db.commit()
    return item


def set_availability(db: Session, actor: User, item_id: int, is_available: bool) -> MenuItem:
    item = _get_item(db, item_id)
    item.is_available = is_available
    audit(db, actor.id, "menu.availability_changed", "menu_item", item.id, f"available={is_available}")
    db.commit()
    return item


def archive_item(db: Session, actor: User, item_id: int) -> MenuItem:
    item = _get_item(db, item_id)
    item.is_active = False
    audit(db, actor.id, "menu.item_archived", "menu_item", item.id)
    db.commit()
    return item


def seed_dev_menu(db: Session, actor: User | None = None) -> int:
    """DEVELOPMENT SAMPLE DATA ONLY. Clearly labelled; prices are made up."""
    if db.scalar(select(MenuCategory.id).limit(1)) is not None:
        return 0
    spec = {
        "Burgers & wraps": [("[DEV SAMPLE] Cedar chicken burger", 45000, False, True, 12),
                            ("[DEV SAMPLE] Spicy chicken wrap", 38000, False, True, 10)],
        "Hot favourites": [("[DEV SAMPLE] Chicken biryani", 42000, False, True, 15),
                           ("[DEV SAMPLE] Masala fries", 22000, False, True, 8),
                           ("[DEV SAMPLE] Chicken samosa", 12000, True, True, None)],
        "Drinks & snacks": [("[DEV SAMPLE] Cold drink", 12000, True, True, None),
                            ("[DEV SAMPLE] Fresh juice", 18000, True, True, None),
                            ("[DEV SAMPLE] Bottled water", 8000, True, True, None),
                            ("[DEV SAMPLE] Chocolate cookie", 10000, True, True, None)],
    }
    count = 0
    for order, (cat_name, items) in enumerate(spec.items()):
        cat = MenuCategory(name=cat_name, sort_order=order)
        db.add(cat)
        db.flush()
        for name, price, quick, sched, prep in items:
            db.add(MenuItem(category_id=cat.id, name=name, price_paisa=price, quick_allowed=quick,
                            scheduled_allowed=sched, prep_minutes=prep))
            count += 1
    db.commit()
    return count
