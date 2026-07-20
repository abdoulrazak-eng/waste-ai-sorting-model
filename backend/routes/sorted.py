from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from models.session import get_db
from models.logs import Logs

crud_router = APIRouter()


@crud_router.get("/get_sorted", status_code=200)
async def get_sorted(db: Session = Depends(get_db)):
    records = (
        db.query(Logs)
        .order_by(Logs.captured_at.desc()) 
        .all()
    )

    return {"data": records}