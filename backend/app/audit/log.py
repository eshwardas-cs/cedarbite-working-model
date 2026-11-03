from app.models.security import AuditLog


def record(db, actor_user_id, action, target=None):
    """Add an audit row. The caller commits, so it lands in the same transaction."""
    db.add(AuditLog(actor_user_id=actor_user_id, action=action, target=target))
