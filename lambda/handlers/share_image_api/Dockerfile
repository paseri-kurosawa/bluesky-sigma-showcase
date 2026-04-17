FROM ubuntu:22.04

# Set up Python runtime layer
ENV PYTHONUNBUFFERED=1
ENV LAMBDA_TASK_ROOT=/var/task
RUN mkdir -p ${LAMBDA_TASK_ROOT}
WORKDIR ${LAMBDA_TASK_ROOT}

# Install system dependencies for Chromium + Python
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    fonts-noto \
    fonts-noto-cjk \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libgbm1 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libasound2 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxkbcommon0 \
    libnspr4 \
    libnss3 \
    libnspr4 \
    libxss1 \
    libdrm2 \
    libxcursor1 \
    libxtst6 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip3 install --no-cache-dir \
    awslambdaric \
    pyppeteer \
    Pillow \
    requests \
    boto3 \
    atproto==0.0.52 \
    python-dateutil>=2.8.2

# Pre-download Chromium during Docker build
RUN HOME=/tmp PYPPETEER_HOME=/tmp/pyppeteer python3 << 'EOF'
import asyncio
from pyppeteer import launch
import os

os.makedirs('/tmp/pyppeteer', exist_ok=True)

try:
    async def download_chromium():
        browser = await launch(headless=True)
        await browser.close()

    asyncio.run(download_chromium())
    print("✓ Chromium downloaded successfully")
except Exception as e:
    print(f"Warning: Chromium download: {e}")
EOF

# Copy downloaded Chromium to a permanent location
RUN mkdir -p /opt/chromium-cache && \
    if [ -d /tmp/pyppeteer ]; then cp -r /tmp/pyppeteer /opt/chromium-cache/ || true; fi

# Skip Chromium verification - will be downloaded at runtime if needed

# Copy function code
COPY handler.py ${LAMBDA_TASK_ROOT}/

# Copy fonts directly into Docker image (Layer alternative)
RUN mkdir -p /opt/python/fonts
COPY fonts/* /opt/python/fonts/

# Lambda Runtime Handler
# Ubuntu base requires explicit Python module invocation
ENTRYPOINT [ "/usr/bin/python3" ]
CMD [ "-m", "awslambdaric", "handler.lambda_handler" ]
