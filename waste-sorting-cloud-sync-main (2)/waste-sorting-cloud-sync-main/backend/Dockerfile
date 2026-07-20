FROM python:3.12-slim
# Set the working directory inside the container
WORKDIR /workspace

# Install any extra system dependencies if you need OpenCV/Vision tasks
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libxcb1 \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Download the latest installer
ADD https://astral.sh/uv/install.sh /uv-installer.sh

# Run the installer then remove it
RUN sh /uv-installer.sh && rm /uv-installer.sh

# Ensure the installed binary is on the `PATH`
ENV PATH="/root/.local/bin/:$PATH"


COPY requirements.txt requirements.txt

RUN uv pip install \
    --system \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    -r requirements.txt


COPY . .


# Copy your local application files

RUN sed -i 's/\r$//' /workspace/start.sh \
    && chmod +x /workspace/start.sh

EXPOSE 8000

CMD ["bash", "/workspace/start.sh"]