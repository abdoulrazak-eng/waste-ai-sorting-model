"""Retry persisted sorting results using their original kiosk and idempotency key."""
import asyncio
from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from models.logs import Logs
from models.session import get_db
from sorting_auth import cloud_request, require_sorting_session

sync_router = APIRouter()


def sync_pending(db: Session, context):
    business_id = context["business"]["id"]
    kiosk_id = context["kiosk"]["kioskId"]
    records = db.query(Logs).filter(Logs.business_id == business_id, Logs.kiosk_id == kiosk_id,
                                  Logs.synced_at.is_(None)).order_by(Logs.captured_at).limit(100).all()
    if not records:
        return {"synced": 0, "pending": 0}
    events = [{"event_id": str(record.idempotency_key), "kiosk_id": kiosk_id, "event_type": "SORT",
               "occurred_at": record.captured_at.replace(tzinfo=timezone.utc).isoformat(),
               "category": record.category.value.upper().replace("-", "_"),
               "confidence": record.confidence / 100, "diverted": record.category.value != "landfill"}
              for record in records]
    result = cloud_request("/sorting/kiosk-export", "POST", {
        "schema_version": 2, "kiosk_id": kiosk_id, "events": events,
    }, context["credential"])
    acknowledged = set(result.get("acknowledgedIds", []))
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    count = 0
    for record in records:
        if str(record.idempotency_key) in acknowledged:
            record.synced_at = now
            count += 1
    db.commit()
    pending = db.query(Logs).filter(Logs.business_id == business_id, Logs.kiosk_id == kiosk_id, Logs.synced_at.is_(None)).count()
    return {"synced": count, "pending": pending}


@sync_router.post("/sync")
async def sync(context=Depends(require_sorting_session), db: Session = Depends(get_db)):
    return await asyncio.to_thread(sync_pending, db, context)
