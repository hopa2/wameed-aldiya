"""Wameed image service: removes the background (rembg, local, free), puts the product
on a clean white square, and stamps the store logo. Used only by n8n on the laptop."""
import io
import os
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageFilter, ImageOps
from rembg import new_session, remove

DATA = os.environ.get("DATA_DIR", "/data")
LOGO = os.path.join(DATA, "logo.png")
MODEL = os.environ.get("REMBG_MODEL", "isnet-general-use")
SIZE = int(os.environ.get("OUT_SIZE", "1200"))
app = FastAPI()
_session = None


def session():
    global _session
    if _session is None:
        _session = new_session(MODEL)
    return _session


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "logo": os.path.exists(LOGO)}


@app.post("/logo")
async def set_logo(file: UploadFile = File(...), remove_bg: str = Form("auto")):
    """Save the store logo. A logo on a flat background gets it removed."""
    img = Image.open(io.BytesIO(await file.read()))
    img = ImageOps.exif_transpose(img).convert("RGBA")
    if remove_bg == "yes" or (remove_bg == "auto" and img.getextrema()[3][0] == 255):
        img = remove(img, session=session())
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)
    os.makedirs(DATA, exist_ok=True)
    img.save(LOGO)
    return {"ok": True, "width": img.width, "height": img.height}


@app.post("/process")
async def process(
    file: UploadFile = File(...),
    logo_pos: str = Form("bottom-left"),
    logo_scale: float = Form(0.18),
    logo_opacity: float = Form(0.9),
    padding: float = Form(0.10),
    fmt: str = Form("jpeg"),
    save_as: str = Form(""),
):
    raw = await file.read()
    try:
        src = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"bad image: {e}")
    src.thumbnail((2400, 2400))
    cut = remove(src, session=session(), post_process_mask=True)
    bbox = cut.getchannel("A").point(lambda a: 255 if a > 20 else 0).getbbox()
    if not bbox:
        raise HTTPException(422, "no product found in photo")
    cut = cut.crop(bbox)
    inner = int(SIZE * (1 - 2 * padding))
    k = inner / max(cut.width, cut.height)  # fill the frame (up or down)
    cut = cut.resize((max(1, int(cut.width * k)), max(1, int(cut.height * k))), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 255))
    # soft shadow so the product does not float
    shadow = Image.new("RGBA", cut.size, (0, 0, 0, 0))
    shadow.putalpha(cut.getchannel("A").point(lambda a: int(a * 0.18)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(12))
    x, y = (SIZE - cut.width) // 2, (SIZE - cut.height) // 2
    canvas.alpha_composite(shadow, (x + 8, y + 14))
    canvas.alpha_composite(cut, (x, y))
    if os.path.exists(LOGO):
        logo = Image.open(LOGO).convert("RGBA")
        w = int(SIZE * logo_scale)
        logo = logo.resize((w, max(1, int(logo.height * w / logo.width))), Image.LANCZOS)
        if logo_opacity < 1:
            logo.putalpha(logo.getchannel("A").point(lambda a: int(a * logo_opacity)))
        m = int(SIZE * 0.03)
        pos = {
            "bottom-left": (m, SIZE - logo.height - m),
            "bottom-right": (SIZE - logo.width - m, SIZE - logo.height - m),
            "top-left": (m, m),
            "top-right": (SIZE - logo.width - m, m),
        }.get(logo_pos, (m, SIZE - logo.height - m))
        canvas.alpha_composite(logo, pos)
    out = io.BytesIO()
    if fmt == "png":
        canvas.save(out, "PNG", optimize=True)
        mime = "image/png"
    else:
        canvas.convert("RGB").save(out, "JPEG", quality=90, optimize=True)
        mime = "image/jpeg"
    if save_as:
        name = "".join(c for c in save_as if c.isalnum() or c in "-_")[:40]
        os.makedirs(os.path.join(DATA, "out"), exist_ok=True)
        with open(os.path.join(DATA, "out", name + (".png" if fmt == "png" else ".jpg")), "wb") as f:
            f.write(out.getvalue())
    return Response(out.getvalue(), media_type=mime, headers={"X-Has-Logo": str(os.path.exists(LOGO)).lower()})


@app.get("/out/{name}")
def get_out(name: str):
    name = "".join(c for c in name if c.isalnum() or c in "-_.")
    path = os.path.join(DATA, "out", name)
    if not os.path.exists(path):
        raise HTTPException(404, "not found")
    return FileResponse(path)
