FROM node:20-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends tor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
COPY torrc /etc/tor/torrc
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
