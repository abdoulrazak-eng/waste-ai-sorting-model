import datetime
from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.orm import Session

from models.logs import Categories, Logs

from models.session import get_db
from inference.mapping import classes
inference_router = APIRouter()

from main import app




@inference_router.post("/inference", status_code=201)
async def inference(
    frame: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    # Read image bytes
    image_bytes = await frame.read()
    

    model = app.state.waste_classifier
    pred_class , conf = model.predict(BytesIO(image_bytes))



    pred_category = Categories(classes[pred_class].lower())
    conf = round(conf, 2) * 100
    if conf >= 50:
        try:
            record = Logs(
                category=pred_category,
                confidence=round(0, 2),
                captured_at=datetime.datetime.now(),
                synced_at=datetime.datetime.now(),
                idempotency_key=uuid4(),
            )
            db.add(record)
            db.commit()
            db.refresh(record)
        finally:
            db.close()
        
        return {
            "class": pred_category,
            "conf": conf,
        }
    return {
        "class" : pred_category,
        "conf" : conf
    }