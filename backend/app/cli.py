"""Administrator commands. Needs access to the server, so it cannot be used from the website.

    python -m app.cli create-owner --email you@example.com
"""
import argparse
import getpass

from app.auth.service import AuthError, create_owner
from app.core.config import load_settings
from app.db.base import Base, make_engine, make_session_factory


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-owner", help="create the first owner account (one time)")
    c.add_argument("--email", required=True)
    sub.add_parser("seed-dev-menu", help="add labelled SAMPLE menu items (development only)")
    args = parser.parse_args(argv)

    settings = load_settings()
    import app.models  # noqa: F401
    engine = make_engine(settings.database_url)
    if settings.env != "production":
        Base.metadata.create_all(engine)

    if args.cmd == "seed-dev-menu":
        if settings.env == "production":
            print("Refusing: sample data is for development only.")
            return 1
        from app.menu.service import seed_dev_menu
        db = make_session_factory(engine)()
        try:
            n = seed_dev_menu(db)
        finally:
            db.close()
        print(f"Added {n} sample items." if n else "Menu already has data; nothing added.")
        return 0

    password = getpass.getpass("Password (min 10 characters): ")
    if password != getpass.getpass("Repeat password: "):
        print("Passwords do not match.")
        return 1
    db = make_session_factory(engine)()
    try:
        user = create_owner(db, args.email, password)
    except (AuthError, ValueError) as e:
        print(f"Error: {e}")
        return 1
    finally:
        db.close()
    print(f"Owner account created for {user.email}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
