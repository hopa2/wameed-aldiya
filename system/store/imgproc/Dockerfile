FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "rembg[cpu]==2.0.67" "pillow==11.1.0" "fastapi==0.115.6" "uvicorn==0.34.0" "python-multipart==0.0.20"
ENV U2NET_HOME=/models
WORKDIR /app
COPY app.py .
# download the model once at build time so the first photo is not slow
RUN python -c "from rembg import new_session; new_session('isnet-general-use')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
