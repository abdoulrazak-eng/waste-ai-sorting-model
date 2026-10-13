from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from models.session import get_db
from models.logs import Logs
from sorting_auth import require_sorting_session

crud_router = APIRouter()


@crud_router.get("/get_sorted", status_code=200)
async def get_sorted(db: Session = Depends(get_db), context=Depends(require_sorting_session)):
    records = (
        db.query(Logs)
        .filter(Logs.business_id == context["business"]["id"])
        .order_by(Logs.captured_at.desc()) 
        .all()
    )

    return {"data": records}
