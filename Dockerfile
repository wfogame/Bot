FROM node:20-slim

# Nuke the problem directories before apt-get tries to overwrite them
RUN rm -rf /usr/share/doc/libevent-2.1-7 \
           /usr/lib/x86_64-linux-gnu/engines-3 \
           /lib/runit-helper \
           /etc/apparmor.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends tor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
COPY torrc /etc/tor/torrc
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
