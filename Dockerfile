FROM node:20-alpine

# Alpine uses apk instead of apt-get, completely bypassing the dpkg bug
RUN apk update && apk add --no-cache tor bash

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Make sure your torrc path is correct for Alpine if Tor expects it elsewhere, 
# but /etc/tor/torrc is standard.
COPY torrc /etc/tor/torrc
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
