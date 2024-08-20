FROM debian:latest AS base

RUN apt-get update \
 && apt-get install -y locales gnupg wget curl ca-certificates \
  # Install Infisical
 && curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' | bash \
 && apt-get update \
 && apt-get install -y infisical \
  # Note: this installs the necessary libs to make the bundled version of Chrome that Puppeteer
  # installs, work.
 && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
 && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] https://dl-ssl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
 && apt-get update \
 && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 dbus dbus-x11 \
    --no-install-recommends \
 && apt-get update \
 && apt-get install -y make git zlib1g-dev libssl-dev gperf cmake clang libc++-dev libc++abi-dev \
    --no-install-recommends \
  # Install runtime dependencies
 && apt-get install -y zip unzip ghostscript graphicsmagick ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.UTF-8

RUN rm -f /etc/machine-id \
 && dbus-uuidgen --ensure=/etc/machine-id

# Install Volta
RUN curl https://get.volta.sh | bash
ENV VOLTA_HOME="/root/.volta"
ENV PATH="$VOLTA_HOME/bin:$PATH"

# Install Node.js and PNPM
RUN volta install node@latest
RUN volta install pnpm@latest
ENV PNPM_HOME="/root/.local/share/pnpm"

COPY . /app
WORKDIR /app

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm pnpm install --frozen-lockfile
RUN pnpm build

ENTRYPOINT [ "/usr/bin/dumb-init", "--" ]
CMD [ "infisical", "run", \
      "--projectId", "6fd5cbbf-ddf0-47b5-938b-ff752c3c6889", \
      "--env", "prod", \
      "--", "pnpm", "start" ]
