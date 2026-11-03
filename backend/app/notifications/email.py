"""Email sending. send() returning True means 'handed to a delivery channel',
NOT 'the person received it'. Real delivery tracking needs a provider (later)."""
from email.message import EmailMessage
import smtplib
import ssl


class EmailSender:
    def send(self, to: str, subject: str, body: str) -> bool:
        raise NotImplementedError


class NullEmailSender(EmailSender):
    """Used when no email provider is configured. Sends nothing."""
    def send(self, to: str, subject: str, body: str) -> bool:
        return False


class ConsoleEmailSender(EmailSender):
    """Development only: prints the email to the server console."""
    def send(self, to: str, subject: str, body: str) -> bool:
        print(f"\n[DEV EMAIL] to={to}\nsubject={subject}\n{body}\n")
        return True


class SMTPEmailSender(EmailSender):
    """SMTP delivery with optional STARTTLS and authenticated credentials."""
    def __init__(self, settings):
        self.host = settings.smtp_host
        self.port = settings.smtp_port
        self.username = settings.smtp_username
        self.password = settings.smtp_password
        self.from_email = settings.smtp_from_email
        self.starttls = settings.smtp_starttls

    def send(self, to: str, subject: str, body: str) -> bool:
        message = EmailMessage()
        message["From"] = self.from_email
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)
        try:
            with smtplib.SMTP(self.host, self.port, timeout=20) as server:
                server.ehlo()
                if self.starttls:
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                if self.username:
                    server.login(self.username, self.password)
                server.send_message(message)
            return True
        except (OSError, smtplib.SMTPException):
            return False


def sender_for(settings) -> EmailSender:
    if settings.email_backend == "console":
        return ConsoleEmailSender()
    if settings.email_backend == "smtp":
        return SMTPEmailSender(settings)
    return NullEmailSender()
