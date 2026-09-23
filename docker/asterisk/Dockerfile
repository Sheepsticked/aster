# syntax=docker/dockerfile:1
# Asterisk 20 + chan_dongle + chan_quectel: pinned multi-stage build of two images.
#
# Stages: asterisk-build (source build with menuselect.opts, staged into /out) → drivers-build (both channel drivers
# at pinned commits; ./patches applied by build-driver.sh) → asterisk-dongle-quectel (the image on its own: base image
# + /out + standalone/) → aster (the default target, Aster's image: rootfs/ on top).

ARG BASE_IMAGE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ARG ASTERISK_VERSION=20.21.0
ARG ASTERISK_SHA256=13fd6e8f1fbb19a3174af82a388dd72c87eb2c92d32fca83c4d51bfab03f686a
ARG CHAN_DONGLE_REPO=https://github.com/wdoekes/asterisk-chan-dongle
ARG CHAN_DONGLE_COMMIT=31eb619600d5ce93237cd440c72db0bc33d7adfe
ARG CHAN_QUECTEL_REPO=https://github.com/IchthysMaranatha/asterisk-chan-quectel
ARG CHAN_QUECTEL_COMMIT=3d45c7f072131296a7e3c1a4faf5bb18751dbd87
# Sounds, MOH, documentation and keys live under ASTDATADIR inside the image; /var/lib/asterisk holds only state
# (astdb, smsdb) so that the production bind mount of state/asterisk does not hide the sounds.
ARG ASTDATADIR=/usr/share/asterisk

# ---- stage 1: build Asterisk ----
FROM ${BASE_IMAGE} AS asterisk-build
ARG ASTERISK_VERSION
ARG ASTERISK_SHA256
ARG ASTDATADIR
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential autoconf automake pkg-config ca-certificates wget git bzip2 patch xz-utils file \
      libedit-dev libjansson-dev libsqlite3-dev libxml2-dev libxslt1-dev uuid-dev libssl-dev libsrtp2-dev libasound2-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
RUN wget -q -O asterisk.tar.gz "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
 && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum -c - \
 && mkdir asterisk && tar -xzf asterisk.tar.gz -C asterisk --strip-components=1 && rm asterisk.tar.gz
COPY menuselect.opts menuselect-apply.sh /usr/src/
WORKDIR /usr/src/asterisk
# Bundled pjproject (version pinned by the tarball, md5-checked by third-party/pjproject) is downloaded here.
RUN ./configure --with-pjproject-bundled --with-jansson-bundled=no \
 && make menuselect.makeopts \
 && sh /usr/src/menuselect-apply.sh apply /usr/src/menuselect.opts
# Sounds (en, ru, moh) are downloaded by sounds/Makefile and sha1-checked. ASTDATADIR is given on the make command
# line so the compiled-in default (defaults.h) and the install location agree. Everything is staged into /out.
# Bundled pjproject is built first and serially: its makefile races under make -j.
RUN make third-party ASTDATADIR="${ASTDATADIR}" \
 && make -j"$(nproc)" ASTDATADIR="${ASTDATADIR}" \
 && make install DESTDIR=/out ASTDATADIR="${ASTDATADIR}" \
 && make install-headers ASTDATADIR="${ASTDATADIR}" \
 && sh /usr/src/menuselect-apply.sh verify /usr/src/menuselect.opts /out/usr/lib/asterisk/modules "/out${ASTDATADIR}" \
 && rm -rf /out/usr/share/man \
      "/out${ASTDATADIR}/static-http" "/out${ASTDATADIR}/rest-api" "/out${ASTDATADIR}/phoneprov" \
      "/out${ASTDATADIR}/firmware" "/out${ASTDATADIR}/images" "/out${ASTDATADIR}/third-party" \
 && find /out/usr/lib /out/usr/sbin -type f \( -name '*.so*' -o -name asterisk \) -exec strip --strip-unneeded {} +
# The base image has /var/run -> /run (merged layout); a staged var/run directory cannot be copied over that symlink.
# The runtime stage creates /var/run/asterisk itself.
RUN rm -rf /out/var/run

# ---- stage 2: build drivers (./patches applied here) ----
FROM asterisk-build AS drivers-build
ARG ASTERISK_VERSION
ARG CHAN_DONGLE_REPO
ARG CHAN_DONGLE_COMMIT
ARG CHAN_QUECTEL_REPO
ARG CHAN_QUECTEL_COMMIT
COPY patches/ /usr/src/patches/
COPY build-driver.sh /usr/src/build-driver.sh
RUN sh /usr/src/build-driver.sh dongle  "${CHAN_DONGLE_REPO}"  "${CHAN_DONGLE_COMMIT}"  "${ASTERISK_VERSION}" /out/usr/lib/asterisk/modules
RUN sh /usr/src/build-driver.sh quectel "${CHAN_QUECTEL_REPO}" "${CHAN_QUECTEL_COMMIT}" "${ASTERISK_VERSION}" /out/usr/lib/asterisk/modules

# ---- stage 3: asterisk-dongle-quectel, usable without Aster ----
FROM ${BASE_IMAGE} AS asterisk-dongle-quectel
ARG ASTERISK_VERSION
ARG CHAN_DONGLE_COMMIT
ARG CHAN_QUECTEL_COMMIT
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libedit2 libjansson4 libsqlite3-0 libxml2 libxslt1.1 libuuid1 libssl3 libsrtp2-1 libasound2 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=drivers-build /out/ /
COPY --from=asterisk-build /usr/src/asterisk/configs/samples/indications.conf.sample /etc/asterisk/indications.conf
COPY standalone/ /
RUN ldconfig \
 && mkdir -p /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/run/asterisk \
 && asterisk -V
LABEL org.opencontainers.image.title="asterisk-dongle-quectel" \
      org.opencontainers.image.description="Asterisk ${ASTERISK_VERSION} with chan_dongle and chan_quectel, patched: USB GSM modems as Asterisk channels" \
      org.opencontainers.image.source="https://github.com/Sheepsticked/aster" \
      org.opencontainers.image.licenses="GPL-2.0-only" \
      aster.asterisk.version="${ASTERISK_VERSION}" \
      aster.chan_dongle.commit="${CHAN_DONGLE_COMMIT}" \
      aster.chan_quectel.commit="${CHAN_QUECTEL_COMMIT}"
VOLUME ["/etc/asterisk", "/var/lib/asterisk", "/var/log/asterisk"]
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m --start-interval=5s --retries=3 CMD asterisk -rx "core show uptime" || exit 1
ENTRYPOINT ["asterisk", "-f", "-U", "root", "-G", "root", "-C", "/etc/asterisk/asterisk.conf"]

# ---- stage 4: aster, the appliance's image ----
FROM asterisk-dongle-quectel AS aster
ARG ASTERISK_VERSION
COPY rootfs/ /
RUN mkdir -p /var/spool/aster/events \
 && chmod 755 /usr/local/bin/aster-emit
LABEL org.opencontainers.image.title="aster/aster-asterisk" \
      org.opencontainers.image.description="Aster GSM gateway: Asterisk ${ASTERISK_VERSION} + chan_dongle + chan_quectel"
VOLUME ["/var/spool/aster"]
