
from contextlib import asynccontextmanager
from fastapi import FastAPI
from inference.run_inference import RunInference
from routes.inference import inference_router
from routes.feedback import feedback_router
from routes.sorted import crud_router
from sorting_auth import auth_router
from sorting_sync import sync_router
import os
import uvicorn
from fastapi.middleware.cors import CORSMiddleware
@asynccontextmanager
async def lifespan(app: FastAPI):
    inference_runner = RunInference("/workspace/classifiers/waste_classifier.onnx")
    app.state.waste_classifier = inference_runner
    yield
    del app.state.waste_classifier

app = FastAPI(lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[value.strip() for value in os.getenv("SORTING_FRONTEND_ORIGINS", "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173").split(",") if value.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(inference_router)
app.include_router(crud_router)
app.include_router(feedback_router)
app.include_router(auth_router)
app.include_router(sync_router)

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
