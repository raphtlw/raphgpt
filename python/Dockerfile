FROM python:3.12-bookworm

RUN apt-get update \
 && apt-get install -y locales gnupg wget curl ca-certificates \
  # Install Infisical
 && curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | bash \
 && apt-get update \
 && apt-get install -y infisical \
  # Install runtime dependencies
 && apt-get install -y zip unzip ghostscript graphicsmagick ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD [ "infisical", "run", \
      "--projectId", "6fd5cbbf-ddf0-47b5-938b-ff752c3c6889", \
      "--env", "prod", \
      "--", "fastapi", "run", "main.py", "--port", "53667" ]
