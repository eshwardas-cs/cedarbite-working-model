FROM node:24-alpine AS web-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix ./frontend
COPY frontend/ ./frontend/
COPY backend/ ./backend/
RUN npm --prefix ./frontend run build

FROM python:3.12-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/ ./
COPY --from=web-build /build/backend/app/web/ ./app/web/
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["sh", "-c", "python -m alembic upgrade head && python -m uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000"]
