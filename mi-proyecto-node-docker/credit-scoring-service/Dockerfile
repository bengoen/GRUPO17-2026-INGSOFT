FROM python:3.11-slim

WORKDIR /app

# Copiamos las dependencias ya instaladas localmente en vendor_python
COPY vendor_python/ /usr/local/lib/python3.11/site-packages/
COPY vendor_python/bin/ /usr/local/bin/

COPY requirements.txt .
COPY app.py .

EXPOSE 5001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001"]
