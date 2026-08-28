ARG TIKA_BASE_IMAGE=apache/tika:3.3.0.0-full@sha256:ecdd37e204308266b1f8e28569f8516ebd5b96d7a4518a71d3904710b20c03b3

FROM ${TIKA_BASE_IMAGE}

ARG TESSDATA_RUS_COMMIT=87416418657359cb625c412a48b6e1d6d41c29bd
ARG TESSDATA_RUS_SHA256=e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225

LABEL org.opencontainers.image.base.digest="sha256:ecdd37e204308266b1f8e28569f8516ebd5b96d7a4518a71d3904710b20c03b3" \
      org.opencontainers.image.description="AIQSA Apache Tika with pinned Russian and English Tesseract OCR assets" \
      org.opencontainers.image.source="https://github.com/insciqq/AIQSA" \
      org.opencontainers.image.version="3.3.0.0-full-rus-eng-1"

USER root

# tessdata_fast is Apache-2.0 licensed. Downloading from an immutable commit
# plus a checked digest keeps the runtime image reproducible without vendoring
# a multi-megabyte model into the application source tree.
RUN set -eux; \
    target=/usr/share/tesseract-ocr/5/tessdata/rus.traineddata; \
    temporary=/tmp/rus.traineddata; \
    wget --https-only --quiet --output-document="$temporary" \
      "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_RUS_COMMIT}/rus.traineddata"; \
    printf '%s  %s\n' "$TESSDATA_RUS_SHA256" "$temporary" | sha256sum --check --strict -; \
    install --mode=0644 "$temporary" "$target"; \
    rm "$temporary"; \
    printf '%s  %s\n' "$TESSDATA_RUS_SHA256" "$target" | sha256sum --check --strict -

USER 35002:35002
