from models.session import get_db
from fastapi import APIRouter, Depends
from models.logs import Learning
from sqlalchemy.orm import Session
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sorting_auth import require_sorting_session

feedback_router = APIRouter()

class Payload(BaseModel):
    image: bytes # base64 encoded
    confidence: int
    label : str

@feedback_router.post("/feedback", status_code=201)
async def feedback(payload: Payload, db: Session = Depends(get_db), context=Depends(require_sorting_session)):
    try:
        record = Learning(
            business_id=context["business"]["id"],
            kiosk_id=context["kiosk"]["kioskId"],
            image=payload.image,
            confidence=(payload.confidence/100),
            label=payload.label,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

        return {"message": "Thank you, this helps"}

    except SQLAlchemyError:
        db.rollback()
        raise
