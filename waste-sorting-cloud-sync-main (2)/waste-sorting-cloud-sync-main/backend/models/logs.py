from sqlalchemy.orm import Mapped, mapped_column
from .enums import Categories
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, LargeBinary, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass





class Logs(Base):
    __tablename__ = "logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[Categories] = mapped_column(Enum(Categories))
    confidence: Mapped[float] = mapped_column(Float)
    captured_at: Mapped[datetime] = mapped_column(DateTime)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    idempotency_key: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        default=uuid.uuid4,
        unique=True,
    )

class Learning(Base):
    __tablename__ = "learning"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    image: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    label: Mapped[str] = mapped_column(String(50), nullable=False)
