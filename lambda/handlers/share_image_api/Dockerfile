FROM debian:11

# Set up Python runtime layer
ENV PYTHONUNBUFFERED=1
ENV LAMBDA_TASK_ROOT=/var/task
RUN mkdir -p ${LAMBDA_TASK_ROOT}
WORKDIR ${LAMBDA_TASK_ROOT}

# Install basic dependencies and rendering libraries
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates \
    libpango-1.0-0 libpango1.0-dev libgdk-pixbuf2.0-0 libffi-dev libcairo2 \
    poppler-utils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt && \
    pip3 install --no-cache-dir awslambdaric

# Copy function code
COPY handler.py ${LAMBDA_TASK_ROOT}/

# Copy logo
COPY bluesky_media_kit_logo_transparent_2.png ${LAMBDA_TASK_ROOT}/

# Copy custom fonts (NotoSansJP + NotoColorEmoji already in fonts/ directory)
RUN mkdir -p /opt/python/fonts
COPY fonts/* /opt/python/fonts/

# Lambda Runtime Handler
ENTRYPOINT [ "/usr/bin/python3", "-m", "awslambdaric" ]
CMD [ "handler.lambda_handler" ]
