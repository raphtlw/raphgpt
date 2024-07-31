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

# Install telegram-bot-api
RUN git clone --recursive https://github.com/tdlib/telegram-bot-api.git \
 && cd telegram-bot-api \
 && rm -rf build \
 && mkdir build \
 && cd build \
 && CXXFLAGS="-stdlib=libc++" CC=/usr/bin/clang CXX=/usr/bin/clang++ cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=/usr/local .. \
 && cmake --build . --target install \
 && cd ../.. \
 && ls -l /usr/local/bin/telegram-bot-api*
ENV PATH="/usr/local/bin:$PATH"
EXPOSE 8081/tcp 8082/tcp

# Install Node.js and PNPM
RUN volta install node@latest
RUN volta install pnpm@latest
ENV PNPM_HOME="/root/.local/share/pnpm"

# Export environment variables to file
ARG INFISICAL_PROJECT_ID
RUN --mount=type=secret,id=INFISICAL_TOKEN \
    INFISICAL_TOKEN=$(cat /run/secrets/INFISICAL_TOKEN) \
    infisical export --env=prod --projectId $INFISICAL_PROJECT_ID > .env

FROM base AS build
COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --filter=telegram-bot --prod /prod/telegram-bot

FROM base AS telegram-bot
COPY --from=build /prod/telegram-bot /prod/telegram-bot
COPY docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT [ "/docker-entrypoint.sh" ]
