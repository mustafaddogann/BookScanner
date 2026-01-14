"""
BookScanner Rectification Backend
FastAPI service for perspective transform rectification

This is a contingency backend for rectification when native OpenCV is not available.
"""

import base64
import io
from typing import List, Tuple
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import cv2
from PIL import Image

app = FastAPI(
    title="BookScanner Rectification API",
    description="Backend service for OBB rectification",
    version="1.0.0"
)

# Enable CORS for React Native app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RectifyRequest(BaseModel):
    """Request model for rectification"""
    image_base64: str
    src_points: List[List[float]]  # [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
    dest_width: int
    dest_height: int


class RectifyResponse(BaseModel):
    """Response model for rectification"""
    image_base64: str
    output_width: int
    output_height: int


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    version: str


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    return HealthResponse(status="healthy", version="1.0.0")


@app.post("/rectify", response_model=RectifyResponse)
async def rectify_image(request: RectifyRequest):
    """
    Perform perspective transform rectification on an image.

    Takes source image and 4 corner points, performs perspective warp
    to produce an upright rectangular crop.
    """
    try:
        # Decode base64 image
        image_data = base64.b64decode(request.image_base64)
        image = Image.open(io.BytesIO(image_data))
        image_np = np.array(image)

        # Convert RGB to BGR for OpenCV
        if len(image_np.shape) == 3 and image_np.shape[2] == 3:
            image_np = cv2.cvtColor(image_np, cv2.COLOR_RGB2BGR)

        # Source points (4 corners of the OBB)
        src_points = np.array(request.src_points, dtype=np.float32)

        # Destination points (upright rectangle)
        dst_points = np.array([
            [0, 0],
            [request.dest_width - 1, 0],
            [request.dest_width - 1, request.dest_height - 1],
            [0, request.dest_height - 1]
        ], dtype=np.float32)

        # Calculate perspective transform matrix
        matrix = cv2.getPerspectiveTransform(src_points, dst_points)

        # Apply perspective warp
        warped = cv2.warpPerspective(
            image_np,
            matrix,
            (request.dest_width, request.dest_height),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE
        )

        # Convert back to RGB
        if len(warped.shape) == 3 and warped.shape[2] == 3:
            warped = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)

        # Encode result to base64
        result_image = Image.fromarray(warped)
        buffer = io.BytesIO()
        result_image.save(buffer, format="JPEG", quality=95)
        result_base64 = base64.b64encode(buffer.getvalue()).decode()

        return RectifyResponse(
            image_base64=result_base64,
            output_width=request.dest_width,
            output_height=request.dest_height
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rectification failed: {str(e)}")


@app.post("/batch_rectify")
async def batch_rectify(requests: List[RectifyRequest]):
    """
    Batch rectification for multiple detections.
    More efficient than individual calls.
    """
    results = []
    for i, request in enumerate(requests):
        try:
            result = await rectify_image(request)
            results.append({"index": i, "success": True, "result": result})
        except HTTPException as e:
            results.append({"index": i, "success": False, "error": e.detail})

    return {"results": results}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
