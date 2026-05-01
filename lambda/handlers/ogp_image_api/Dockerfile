FROM mcr.microsoft.com/playwright/python:v1.52.0-noble

ENV PYTHONUNBUFFERED=1
ENV LAMBDA_TASK_ROOT=/var/task
RUN mkdir -p ${LAMBDA_TASK_ROOT}
WORKDIR ${LAMBDA_TASK_ROOT}

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir awslambdaric

# Install only Chromium browser
RUN playwright install chromium

# Copy fonts to system font directory
RUN mkdir -p /usr/share/fonts/custom
COPY fonts/* /usr/share/fonts/custom/
RUN fc-cache -f -v

# Copy function code and assets
COPY handler.py ${LAMBDA_TASK_ROOT}/
COPY bluesky_media_kit_logo_transparent_2.png ${LAMBDA_TASK_ROOT}/

ENTRYPOINT [ "python", "-m", "awslambdaric" ]
CMD [ "handler.lambda_handler" ]
