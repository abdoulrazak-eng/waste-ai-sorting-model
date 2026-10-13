import datetime
from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, Depends, File, UploadFile, Request
from sqlalchemy.orm import Session

from models.logs import Categories, Logs

from models.session import get_db
from inference.mapping import classes
from sorting_auth import require_sorting_session
inference_router = APIRouter()





@inference_router.post("/inference", status_code=201)
async def inference(
    request: Request,
    frame: UploadFile = File(...),
    db: Session = Depends(get_db),
    context=Depends(require_sorting_session),
):
    # Read image bytes
    image_bytes = await frame.read()
    

    model = request.app.state.waste_classifier
    pred_class , conf = model.predict(BytesIO(image_bytes))



    pred_category = Categories(classes[pred_class].lower())
    conf = round(conf, 2) * 100
    if conf >= 50:
        try:
            record = Logs(
                category=pred_category,
                confidence=conf,
                captured_at=datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None),
                synced_at=None,
                business_id=context["business"]["id"],
                kiosk_id=context["kiosk"]["kioskId"],
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
