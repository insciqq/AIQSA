ARG DOCLING_BASE_IMAGE=quay.io/docling-project/docling-serve-cpu:v1.21.0@sha256:c7d56cf78c45ab61406bc2dfebbac562c16e38538393f838991a949577cd3d0a

FROM ${DOCLING_BASE_IMAGE}

ARG EASYOCR_CYRILLIC_ARCHIVE_URL=https://github.com/JaidedAI/EasyOCR/releases/download/v1.6.1/cyrillic_g2.zip
ARG EASYOCR_CYRILLIC_ARCHIVE_SHA256=34060353accfadd4e429f28d392f88cf70c2fc9d2633710a3b00c21412dc627b
ARG EASYOCR_CYRILLIC_MODEL_SHA256=48d0f3b58f28aa64651ab1032cc2d498c4de25135829668e87c14e7a07529f29

LABEL org.opencontainers.image.base.digest="sha256:c7d56cf78c45ab61406bc2dfebbac562c16e38538393f838991a949577cd3d0a" \
      org.opencontainers.image.description="AIQSA Docling Serve with offline EasyOCR Russian and English assets" \
      org.opencontainers.image.source="https://github.com/insciqq/AIQSA" \
      org.opencontainers.image.version="v1.21.0-easyocr-ru-en-1"

COPY --chmod=0555 verify-ocr-assets.py /opt/app-root/src/aiqsa-verify-ocr-assets.py

# EasyOCR 1.7.2 selects cyrillic_g2 for [ru, en]. The digest-pinned upstream
# image already contains the CRAFT detector; this layer verifies that input,
# downloads only the missing recognition archive, and never retains the zip.
RUN set -eux; \
    model_dir=/opt/app-root/src/.cache/docling/models/EasyOcr; \
    archive=/tmp/cyrillic_g2.zip; \
    model_tmp="$model_dir/cyrillic_g2.pth.tmp"; \
    printf '%s  %s\n' '4a5efbfb48b4081100544e75e1e2b57f8de3d84f213004b14b85fd4b3748db17' "$model_dir/craft_mlt_25k.pth" | sha256sum -c -; \
    curl --fail --location --silent --show-error --retry 3 \
      --output "$archive" "$EASYOCR_CYRILLIC_ARCHIVE_URL"; \
    printf '%s  %s\n' "$EASYOCR_CYRILLIC_ARCHIVE_SHA256" "$archive" | sha256sum -c -; \
    unzip -p "$archive" cyrillic_g2.pth > "$model_tmp"; \
    printf '%s  %s\n' "$EASYOCR_CYRILLIC_MODEL_SHA256" "$model_tmp" | sha256sum -c -; \
    mv "$model_tmp" "$model_dir/cyrillic_g2.pth"; \
    rm "$archive"; \
    python /opt/app-root/src/aiqsa-verify-ocr-assets.py
