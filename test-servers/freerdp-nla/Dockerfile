# An RDP server that requires Network Level Authentication, like Windows does
# by default — so wrong-password handling can be tested without Windows.
#
#   docker build -t hopdesk-test-nla test-servers/freerdp-nla
#   docker run -d --name hopdesk-nla -p 127.0.0.1:13390:3389 hopdesk-test-nla
#   HOPDESK_RDP_NLA_TEST='127.0.0.1:13390:nlauser:NlaPass!45' npm test
#
# FreeRDP's shadow server shares a virtual X display. Test credentials only.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends freerdp2-shadow-x11 xvfb python3 \
 && rm -rf /var/lib/apt/lists/*
COPY make-sam.py /usr/local/bin/make-sam.py
RUN mkdir -p /etc/winpr && python3 /usr/local/bin/make-sam.py nlauser 'NlaPass!45' > /etc/winpr/SAM
CMD ["sh", "-c", "Xvfb :55 -screen 0 1024x768x24 & sleep 1; DISPLAY=:55 exec freerdp-shadow-cli /port:3389 +auth /sec:nla"]
