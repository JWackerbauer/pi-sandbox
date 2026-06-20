FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends maven curl bash ca-certificates git ripgrep jq \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Create non-root user (no sudo access)
RUN groupadd -g 1001 pi \
  && useradd -m -u 1001 -g 1001 -s /bin/bash pi \
  && mkdir -p /workspace \
  && chown pi:pi /workspace \
  && chown -R pi:pi /home/linuxbrew/.linuxbrew

COPY pi-wrapper.sh /usr/local/bin/pi-wrapper.sh
RUN chmod +x /usr/local/bin/pi-wrapper.sh
RUN chown pi:pi /usr/local/bin/pi-wrapper.sh

USER pi
WORKDIR /workspace

ENV PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
ENV HOMEBREW_NO_AUTO_UPDATE=1

RUN brew install tmux go yq

COPY .tmux.conf /home/pi/.tmux.conf

ENTRYPOINT ["/usr/local/bin/pi-wrapper.sh"]
