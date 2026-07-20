from models.session import get_db
from fastapi import APIRouter, Depends
from models.logs import Learning
from sqlalchemy.orm import Session
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

feedback_router = APIRouter()

class Payload(BaseModel):
    image: bytes # base64 encoded
    confidence: int
    label : str

@feedback_router.post("/feedback", status_code=201)
async def feedback(payload: Payload, db: Session = Depends(get_db)):
    try:
        record = Learning(
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