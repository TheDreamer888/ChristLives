FROM python:3.12.8-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir poetry==2.2.1

COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false \
    && poetry install --no-root --only main

COPY src ./src
COPY migrations ./migrations
COPY alembic.ini ./alembic.ini

RUN useradd --create-home --shell /bin/false appuser \
    && mkdir -p /app/src/app/data \
    && chown appuser:appuser /app/src/app/data
USER appuser

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/ready')" || exit 1

CMD ["uvicorn", "src.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
