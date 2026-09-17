# An RDP server for HopDesk's live RDP test, so no Windows machine is needed.
#
#   docker build -t hopdesk-test-xrdp test-servers/xrdp
#   docker run -d --name hopdesk-xrdp -p 127.0.0.1:13389:3389 hopdesk-test-xrdp
#   HOPDESK_RDP_TEST='127.0.0.1:13389:rdpuser:RdpPass!23' npm test
#
# xrdp uses TLS with a self-signed certificate, so it also exercises the
# certificate prompt. It does not do NLA; Windows does. Test credentials only —
# bind the port to 127.0.0.1 as above.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends xrdp xorgxrdp xterm dbus-x11 \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash rdpuser && echo 'rdpuser:RdpPass!23' | chpasswd && adduser xrdp ssl-cert
RUN printf '#!/bin/sh\nexec xterm -geometry 120x40+0+0\n' > /etc/xrdp/startwm.sh && chmod +x /etc/xrdp/startwm.sh
CMD ["sh", "-c", "rm -f /var/run/xrdp/*.pid; xrdp-sesman && exec xrdp --nodaemon"]
